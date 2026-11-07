import { createWorker, PSM as TessPSM } from 'tesseract.js';
import type { Worker as TesseractWorker } from 'tesseract.js';
import { PDFDocument } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { loadPdfJsDoc, renderPageToCanvas } from './thumb';
import { processCanvas, normalizeOcrText } from './preprocess';
import type { PreprocessMode } from './preprocess';
import { layoutText } from './ocr-layout';
import type { OcrResult } from './types';

export type ExtractMode = 'smart' | 'layer' | 'ocr';
export type OcrLang = 'chi+eng' | 'chi' | 'eng';
export type OcrPsm = 'block' | 'auto' | 'column' | 'sparse';

export interface OcrSettings {
  /** 渲染分辨率：小字 / 扫描件建议 350~400 */
  dpi: number;
  /** 图像预处理：auto 会按内容自动判断二值化、去噪、纠偏、反相 */
  preprocess: PreprocessMode;
  /** 页面分割模式：整块文字 / 自动 / 单栏 / 稀疏文字（表单、票据） */
  psm: OcrPsm;
  lang: OcrLang;
  /** 多栏文档按坐标还原阅读顺序 */
  layout: boolean;
}

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  dpi: 350,
  preprocess: 'auto',
  psm: 'block',
  lang: 'chi+eng',
  layout: true,
};

const LANGS: Record<OcrLang, string[]> = {
  'chi+eng': ['chi_sim', 'eng'],
  chi: ['chi_sim'],
  eng: ['eng'],
};
const PSM: Record<OcrPsm, TessPSM> = {
  block: TessPSM.SINGLE_BLOCK,
  auto: TessPSM.AUTO,
  column: TessPSM.SINGLE_COLUMN,
  sparse: TessPSM.SPARSE_TEXT,
};
/** 限制单页像素总量，避免超大画布让 WebView 分配失败 */
const MAX_CANVAS_AREA = 26_000_000;

type Progress = (done: number, total: number, status: string) => void;

const workerCache = new Map<string, Promise<TesseractWorker>>();

/**
 * 完全离线的 OCR worker：worker / WASM core / 高精度语言包随应用打包在 public/ocr，
 * 不访问 CDN，不需要用户安装任何系统软件。按语言组合缓存，切换语言才重建。
 */
export async function getWorker(langs: string[] = LANGS['chi+eng']): Promise<TesseractWorker> {
  const key = langs.join('+');
  let pending = workerCache.get(key);
  if (!pending) {
    pending = createWorker(langs, 1, {
      workerPath: '/ocr/worker.min.js',
      corePath: '/ocr/core',
      langPath: '/ocr/tessdata',
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
    });
    workerCache.set(key, pending);
  }
  return pending;
}

export async function terminateOcr() {
  const all = [...workerCache.values()];
  workerCache.clear();
  for (const p of all) {
    const worker = await p.catch(() => null);
    if (worker) await worker.terminate();
  }
}

/** 直接读取 PDF 文本层，电子版 PDF 瞬间完成 */
export async function extractTextLayer(
  baseBytes: Uint8Array,
  pageNumbers: number[],
  onProgress?: Progress,
): Promise<OcrResult[]> {
  const doc = await loadPdfJsDoc(baseBytes);
  const out: OcrResult[] = [];
  try {
    for (let i = 0; i < pageNumbers.length; i++) {
      const page = await doc.getPage(pageNumbers[i]);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str;
          if (item.hasEOL) text += '\n';
        }
      }
      out.push({
        pageNumber: pageNumbers[i],
        text: text.trim(),
        confidence: 100,
        source: 'layer',
      });
      onProgress?.(i + 1, pageNumbers.length, '读取文本层');
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

interface RawWord {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  confidence?: number;
}

function wordsFromResult(data: { words?: RawWord[] }): RawWord[] {
  return (data.words ?? []).filter((w) => w.text && w.text.trim() && w.bbox);
}

function normalizedWords(words: RawWord[], width: number, height: number) {
  return words.map((w) => ({
    text: w.text,
    x: Math.max(0, Math.min(1, w.bbox.x0 / width)),
    y: Math.max(0, Math.min(1, w.bbox.y0 / height)),
    w: Math.max(0, Math.min(1, (w.bbox.x1 - w.bbox.x0) / width)),
    h: Math.max(0, Math.min(1, (w.bbox.y1 - w.bbox.y0) / height)),
  }));
}

/** 栅格化页面后交给 Tesseract 识别（扫描件 / 图片型 PDF） */
export async function recognizePages(
  baseBytes: Uint8Array,
  pageNumbers: number[],
  onProgress?: Progress,
  settings: OcrSettings = DEFAULT_OCR_SETTINGS,
): Promise<OcrResult[]> {
  onProgress?.(0, pageNumbers.length, '正在加载离线 OCR 引擎…');
  const worker = await getWorker(LANGS[settings.lang]);
  const doc = await loadPdfJsDoc(baseBytes);
  const out: OcrResult[] = [];
  try {
    for (let i = 0; i < pageNumbers.length; i++) {
      const n = pageNumbers[i];
      onProgress?.(i, pageNumbers.length, `正在处理第 ${n} 页`);
      const natural = (await doc.getPage(n)).getViewport({ scale: 1 });
      const area = Math.max(1, natural.width * natural.height);
      const scale = Math.min(settings.dpi / 72, Math.sqrt(MAX_CANVAS_AREA / area));
      const canvas = await renderPageToCanvas(doc, n, scale);
      // 预处理器会在源图偏小时自动 2× 放大，让小字达到引擎需要的字高
      const { canvas: proc, result: prep } = processCanvas(canvas, settings.preprocess);
      onProgress?.(i, pageNumbers.length,
        `正在识别第 ${n} 页${prep.applied !== 'none' ? `（${prep.applied === 'binary' ? '二值化' : '增强'}）` : ''}`);

      await worker.setParameters({
        tessedit_pageseg_mode: PSM[settings.psm],
        preserve_interword_spaces: '1',
        user_defined_dpi: String(Math.round(scale * 72)),
      });
      const { data } = await worker.recognize(proc.toDataURL('image/png'), {},
        { blocks: true, text: true, hocr: false, tsv: false });

      const words = wordsFromResult(data);
      let raw = data.text ?? '';
      let columns = 1;
      if (settings.layout && words.length) {
        const lay = layoutText(words, proc.width);
        if (lay.columns > 1) { raw = lay.text; columns = lay.columns; }
      }
      out.push({
        pageNumber: n,
        text: normalizeOcrText(raw),
        confidence: data.confidence ?? 0,
        source: 'ocr',
        columns,
        preprocess: prep.applied,
        angle: prep.stats.angle,
        upscale: prep.stats.upscale,
        words: normalizedWords(words, proc.width, proc.height),
      });
      onProgress?.(i + 1, pageNumbers.length, `第 ${n} 页完成`);
    }
  } finally {
    await doc.destroy();
  }
  return out;
}

/** 智能模式：先读文本层，几乎没有文字的页自动改走 OCR */
export async function extractPages(
  baseBytes: Uint8Array,
  pageNumbers: number[],
  mode: ExtractMode,
  onProgress?: Progress,
  settings: OcrSettings = DEFAULT_OCR_SETTINGS,
): Promise<OcrResult[]> {
  if (mode === 'ocr') return recognizePages(baseBytes, pageNumbers, onProgress, settings);
  const layer = await extractTextLayer(baseBytes, pageNumbers, onProgress);
  if (mode === 'layer') return layer;

  const scanned = layer.filter((r) => r.text.replace(/\s/g, '').length < 10);
  if (!scanned.length) return layer;
  const ocred = await recognizePages(
    baseBytes, scanned.map((r) => r.pageNumber), onProgress, settings,
  );
  const map = new Map(ocred.map((r) => [r.pageNumber, r]));
  return layer.map((r) => map.get(r.pageNumber) ?? r);
}

/** 把识别结果按词坐标写成透明文本层，得到可搜索 / 可复制的 PDF */
export async function makeSearchablePdf(
  baseBytes: Uint8Array,
  results: OcrResult[],
): Promise<Uint8Array> {
  const usable = results.filter((r) => r.text.trim());
  if (!usable.length) return baseBytes;

  const res = await fetch('/ocr/fonts/NotoSansCJKsc-Regular.otf');
  if (!res.ok) throw new Error('中文字体资源缺失');
  const fontBytes = new Uint8Array(await res.arrayBuffer());

  const out = await PDFDocument.load(baseBytes);
  out.registerFontkit(fontkit);
  const font = await out.embedFont(fontBytes, { subset: true });

  for (const r of usable) {
    if (r.pageNumber - 1 >= out.getPageCount()) continue;
    const page = out.getPage(r.pageNumber - 1);
    const W = page.getWidth(), H = page.getHeight();
    const draw = (text: string, x: number, y: number, size: number, maxWidth: number) => {
      if (!text || size < 0.5) return;
      try {
        page.drawText(text.slice(0, 120), { x, y, size, font, opacity: 0, maxWidth });
      } catch { /* 忽略个别无法编码的字符 */ }
    };

    if (r.words?.length) {
      for (const w of r.words) {
        const boxH = Math.max(2, w.h * H);
        draw(w.text, w.x * W, H - w.y * H - boxH, boxH * 0.82, Math.max(2, w.w * W));
      }
    } else {
      const lines = r.text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const lineHeight = Math.min(12, H / Math.max(lines.length, 1));
      lines.forEach((line, i) => draw(line, 0, H - (i + 1) * lineHeight, lineHeight * 0.85, W));
    }
  }
  return out.save({ useObjectStreams: true });
}

export function resultsToTxt(results: OcrResult[]): string {
  return results
    .map((r) => `──── 第 ${r.pageNumber} 页${r.source === 'ocr' ? '（OCR）' : ''} ────\n${r.text}`)
    .join('\n\n');
}
