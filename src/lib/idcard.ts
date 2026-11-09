import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { getWorker } from './ocr';
import { processCanvas, normalizeOcrText } from './preprocess';
import { correctOcrText } from './ocr-correct';
import { PSM } from 'tesseract.js';
import { MM, A4_W, A4_H, CARD_W, CARD_H, CARD_PX_W, CARD_PX_H } from './idcard-const';
import {
  detectCardRect, analyzeImage, drawRotated, minimalCrop, rotateFree, clampAngle, MAX_BASE,
} from './idcard-detect';
import type { Analysis, CropRect, Rotation } from './idcard-detect';
export { MM, A4_W, A4_H, CARD_W, CARD_H, CARD_RATIO, CARD_PX_W, CARD_PX_H } from './idcard-const';
export {
  detectCardRect, analyzeImage, drawRotated, zoomCrop, panCrop, moveCrop,
  resizeCrop, containLayout, minimalCrop, cropRatio, rotateFree, clampAngle, orthoSteps,
} from './idcard-detect';
export type { CropRect, Rotation, DetectResult } from './idcard-detect';

/**
 * 身份证照片 → A4 实尺复印件。
 * 全部在浏览器/webview 内完成：自动定位证件区域 + Canvas 裁剪 + 可选离线 OCR 判面
 * + pdf-lib 按物理尺寸排版。不引入 Python、不引入新依赖、图片不出本机。
 */

export type CardSide = 'front' | 'back' | 'unknown';
export const SIDE_LABEL: Record<CardSide, string> = {
  front: '人像面', back: '国徽面', unknown: '未指定',
};

export interface IdCardSource {
  id: string;
  name: string;
  url: string;                 // 预览用 objectURL，卸载时记得 revoke
  image: HTMLImageElement;     // 原图，供重新定位 / 旋转使用
  base0: HTMLCanvasElement;    // 只按 rotation 正交旋转的画布（改角度时复用，不重跑检测）
  base: HTMLCanvasElement;     // base0 再叠加 angle 后的画布（预览、框选与 PDF 共用）
  crop: CropRect;              // 归一化裁剪框，物理比例恒为 1.5852
  rotation: Rotation;          // 已把竖拍证件转正（0/90/180/270）
  angle: number;               // 自由旋转角度：正顺时针、负逆时针，可手写小数
  side: CardSide;
  detectedBy?: 'ocr' | 'name' | 'manual';
  ocrText?: string;
  /** 字段级白名单识别出的身份证号（仅人像面，通过校验时才填） */
  idNumber?: string;
  /** 号码是否通过 MOD 11-2 校验 */
  idNumberValid?: boolean;
  locate?: { ok: boolean; quality: number; reason: string };
}

export interface IdCardOptions {
  perPage: 1 | 2;
  gapMm: number;
  label: boolean;
  quality: number;
}

export const DEFAULT_OPTIONS: IdCardOptions = {
  perPage: 2, gapMm: 12, label: false, quality: 0.92,
};

export interface Placement {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 纯函数：把 n 张证件按每页 1/2 张、整体居中排到 A4 上，返回 pt 坐标 */
export function layoutPlacements(count: number, perPage: 1 | 2, gapMm: number): Placement[][] {
  const pages: Placement[][] = [];
  const gap = gapMm * MM;
  const x = (A4_W - CARD_W) / 2;
  for (let i = 0; i < count; i += perPage) {
    const n = Math.min(perPage, count - i);
    const totalH = n * CARD_H + (n - 1) * gap;
    const y0 = (A4_H - totalH) / 2;
    const group: Placement[] = [];
    for (let j = 0; j < n; j++) {
      group.push({
        index: i + j,
        x,
        y: y0 + (n - 1 - j) * (CARD_H + gap),
        width: CARD_W,
        height: CARD_H,
      });
    }
    pages.push(group);
  }
  return pages;
}

/** 人像面在上、国徽面在下；同面保持输入顺序 */
export function sortCards(cards: IdCardSource[]): IdCardSource[] {
  const rank: Record<CardSide, number> = { front: 0, back: 1, unknown: 2 };
  return cards
    .map((card, i) => ({ card, i }))
    .sort((a, b) => rank[a.card.side] - rank[b.card.side] || a.i - b.i)
    .map((v) => v.card);
}

/** 读取本地图片（浏览器自动处理 EXIF 方向） */
export async function loadImageFile(file: File): Promise<{ image: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    if (typeof image.decode === 'function') await image.decode();
    else await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('图片解码失败'));
    });
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
  return { image, url };
}

export interface CardGeometry {
  rotation: Rotation;
  angle: number;
  base0: HTMLCanvasElement;
  base: HTMLCanvasElement;
  crop: CropRect;
  locate: { ok: boolean; quality: number; reason: string };
}

function geometryFrom(
  image: HTMLImageElement, rotation: Rotation,
  a: Analysis, located: boolean, reason: string, angle = 0,
): CardGeometry {
  const base0 = drawRotated(image, rotation, MAX_BASE);
  const base = rotateFree(base0, angle);
  return {
    rotation, angle: clampAngle(angle), base0, base,
    // 低置信度也沿用检测框；整图兜底会把证件缩成一小块，反而看不出放在哪里
    crop: a.quality < 0.08 ? minimalCrop(base.width, base.height) : a.rect,
    locate: { ok: located, quality: a.quality, reason },
  };
}

/** 导入图片时调用：自动找证件、把竖拍转正、生成预览/PDF 共用的归一化画布 */
export function autoGeometry(image: HTMLImageElement, angle = 0): CardGeometry {
  const d = detectCardRect(image);
  return geometryFrom(image, d.rotation, d, d.located, d.reason, angle);
}

/** 手动整步旋转 / OCR 纠正倒置后调用：在指定方向上重新定位一次，保留已有微调角度 */
export function geometryAt(
  image: HTMLImageElement, rotation: Rotation, angle = 0,
): CardGeometry {
  const a = analyzeImage(image, rotation);
  const located = a.quality >= 0.20 && a.fit >= 0.22;
  return geometryFrom(
    image, rotation, a, located,
    located ? '已重新定位证件区域' : '定位置信度偏低，请在「原图框选」里确认取景框',
    angle,
  );
}

/** 只改自由旋转角度：复用正交底图，不重跑图片检测，也不动取景框 */
export function withAngle(card: IdCardSource, angle: number): Partial<IdCardSource> {
  const a = clampAngle(angle);
  const base0 = card.base0 ?? card.base;
  return { angle: a, base0, base: rotateFree(base0, a) };
}

/**
 * 按自动定位（或手动调整后）的裁剪框生成卡片画布。
 * crop 的物理比例恒为 1.5852，与 CARD_PX_W/H 一致，因此不会被拉伸。
 * 预览和 PDF 都调用这里，所见即所得。
 */
export function renderCardCanvas(card: IdCardSource): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = CARD_PX_W;
  canvas.height = CARD_PX_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_PX_W, CARD_PX_H);

  const src = card.base || card.image;
  const sw = src.width || card.image.naturalWidth;
  const sh = src.height || card.image.naturalHeight;
  if (!sw || !sh) return canvas;
  const c = card.crop || { x: 0, y: 0, w: 1, h: 1 };
  ctx.drawImage(
    src,
    c.x * sw, c.y * sh, c.w * sw, c.h * sh,
    0, 0, CARD_PX_W, CARD_PX_H,
  );
  return canvas;
}

// ---- 正反面判定 ----
const FRONT_RULES: [string, number][] = [
  ['公民身份号码', 3], ['公民身份证号码', 3], ['姓名', 2], ['住址', 2],
  ['出生', 2], ['性别', 1], ['民族', 1],
];
const BACK_RULES: [string, number][] = [
  ['签发机关', 3], ['有效期限', 3], ['中华人民共和国', 2], ['居民身份证', 1],
];

export interface SideGuess {
  side: CardSide;
  confidence: number;
  hits: string[];
}

export function scoreSide(raw: string): SideGuess {
  const text = raw.replace(/\s/g, '');
  const frontHits = FRONT_RULES.filter(([kw]) => text.includes(kw)).map(([kw]) => kw);
  const backHits = BACK_RULES.filter(([kw]) => text.includes(kw)).map(([kw]) => kw);
  let front = FRONT_RULES.reduce((n, [kw, w]) => n + (text.includes(kw) ? w : 0), 0);
  let back = BACK_RULES.reduce((n, [kw, w]) => n + (text.includes(kw) ? w : 0), 0);
  if (/\d{17}[\dXx]/.test(text)) front += 3;
  const side: CardSide = front === 0 && back === 0
    ? 'unknown' : front > back ? 'front' : 'back';
  return {
    side,
    confidence: Math.max(front, back),
    hits: front >= back ? frontHits : backHits,
  };
}

export function guessSideFromName(name: string): CardSide {
  const n = name.toLowerCase();
  if (/(front|portrait|正面|人像|头像|face|zheng)/.test(n)) return 'front';
  if (/(back|emblem|反面|国徽|reverse|fan)/.test(n)) return 'back';
  return 'unknown';
}

export interface OcrGuess extends SideGuess { text: string; upsideDown: boolean }

/**
 * 复用应用内置的离线 Tesseract worker（chi_sim + eng），不联网、不新增依赖。
 * 输入是自动定位后裁好的卡片图，不再是大片留白的整张照片，命中率明显更高。
 */
export async function detectSideByOcr(card: IdCardSource): Promise<OcrGuess> {
  const worker = await getWorker();
  // 证件文字稀疏且分散，用 PSM 11；小尺寸卡片图放大后再增强
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SPARSE_TEXT,
    preserve_interword_spaces: '1',
    user_defined_dpi: '300',
  });
  const { canvas } = processCanvas(renderCardCanvas(card), 'auto',
    { upscale: 2, deskew: false });
  const { data } = await worker.recognize(canvas.toDataURL('image/png'));
  const text = filterNoiseLines(correctOcrText(normalizeOcrText((data.text ?? '').trim())));
  const guess = scoreSide(text);
  if (guess.side !== 'unknown' && guess.confidence >= 3) {
    return { ...guess, text, upsideDown: false };
  }

  // 命中不足时再试 180° 倒置，顺带告诉调用方需要翻正
  const flipped = document.createElement('canvas');
  flipped.width = canvas.width;
  flipped.height = canvas.height;
  const ctx = flipped.getContext('2d');
  if (ctx) {
    ctx.translate(flipped.width, flipped.height);
    ctx.rotate(Math.PI);
    ctx.drawImage(canvas, 0, 0);
    const r2 = await worker.recognize(flipped.toDataURL('image/png'));
    const t2 = filterNoiseLines(correctOcrText(normalizeOcrText((r2.data.text ?? '').trim())));
    const g2 = scoreSide(t2);
    if (g2.confidence > guess.confidence) return { ...g2, text: t2, upsideDown: true };
  }
  return { ...guess, text, upsideDown: false };
}

// ---- 身份证号提取（白名单 + 校验码） ----

import {
  isValidIdNumber, expectedCheckDigit, findIdCandidate,
} from './id-number';
import { filterNoiseLines } from './ocr-correct';

export { isValidIdNumber } from './id-number';

export interface IdNumberResult {
  /** 通过 MOD 11-2 校验的 18 位号码；未得到可信结果时为 undefined */
  number?: string;
  /** 原始识别串（规范化前），便于排查 */
  raw: string;
  /** 是否通过校验码验证 */
  valid: boolean;
  /** 当 17 位主体可信、仅校验位错时给出修复候选（仍标记 valid=false 由调用方决定） */
  repaired?: string;
}

/**
 * 字段级二次识别身份证号：号码行固定在证件底部约 72%~96% 高度。
 * 流程：裁剪号码带 → 白名单('0123456789X')单行识别 → 混淆字符规范化
 * → 正则提取 18 位 → MOD 11-2 校验。白名单失败时回退到无白名单全宽识别。
 */
export async function extractIdNumber(card: IdCardSource): Promise<IdNumberResult> {
  const worker = await getWorker();
  const cardCanvas = renderCardCanvas(card);

  const bandTop = Math.round(cardCanvas.height * 0.70);
  const bandH = Math.round(cardCanvas.height * 0.26);
  const band = document.createElement('canvas');
  band.width = cardCanvas.width;
  band.height = bandH;
  const bctx = band.getContext('2d');
  if (!bctx) throw new Error('无法创建 canvas 上下文');
  bctx.fillStyle = '#ffffff';
  bctx.fillRect(0, 0, band.width, band.height);
  bctx.drawImage(
    cardCanvas, 0, bandTop, cardCanvas.width, bandH,
    0, 0, band.width, band.height,
  );

  // 号码行是单一长串，用 SINGLE_LINE；白名单只留数字与 X。
  // 识别链路逐级兜底：auto 预处理 → Sauvola 二值化（治椒盐噪声）→ 无白名单稀疏模式。
  // （tesseract.js 的 LSTM 对白名单是硬过滤，输入稍差会输出空串，所以必须留退路）
  const passes: Array<{ mode: 'auto' | 'binary'; sparse: boolean }> = [
    { mode: 'auto', sparse: false },
    { mode: 'binary', sparse: false },
    { mode: 'binary', sparse: true },
  ];
  let raw = '';
  let candidate: string | undefined;
  for (const [idx, p] of passes.entries()) {
    const { canvas } = processCanvas(band, p.mode, { upscale: 3, deskew: false });
    await worker.setParameters({
      tessedit_pageseg_mode: p.sparse ? PSM.SPARSE_TEXT : PSM.SINGLE_LINE,
      tessedit_char_whitelist: p.sparse ? '' : '0123456789X',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    const { data } = await worker.recognize(canvas.toDataURL('image/png'));
    raw = (data.text ?? '').trim();
    candidate = findIdCandidate(raw);
    if (candidate) {
      // 首选通过即停；校验失败也继续兜底重试，取后续更可信结果
      if (idx === passes.length - 1 || isValidIdNumber(candidate)) break;
    }
  }

  if (!candidate) return { raw, valid: false };

  const valid = isValidIdNumber(candidate);
  const result: IdNumberResult = { raw, valid };
  if (valid) {
    result.number = candidate;
  } else {
    // 17 位主体通常比对错校验位更可信：算出应有校验位供参考
    const fixed = candidate.slice(0, 17) + expectedCheckDigit(candidate.slice(0, 17));
    if (fixed !== candidate) result.repaired = fixed;
  }
  return result;
}

/**
 * 检查结果画面是否出现「只有上半 / 只有左半有内容」的异常。
 * 正常证件上下左右都有文字或图案；这种失衡通常意味着源照片本身被截断，
 * 或者取景框严重偏移，不能当作成功结果交给用户。
 */
export function resultHalfEmpty(canvas: HTMLCanvasElement): 'none' | 'bottom' | 'right' {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 'none';
  const W = canvas.width, H = canvas.height;
  const data = ctx.getImageData(0, 0, W, H).data;
  let top = 0, bottom = 0, left = 0, right = 0;
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      const p = (y * W + x) * 4;
      // 只统计明显比白纸深的像素（文字、图案、边框），忽略浅色底纹
      const dark = 255 - Math.min(data[p], data[p + 1], data[p + 2]) > 42 ? 1 : 0;
      if (y < H / 2) top += dark; else bottom += dark;
      if (x < W / 2) left += dark; else right += dark;
    }
  }
  const quarter = (W / 2) * (H / 2);
  if (top > quarter * 0.008 && bottom < top * 0.15) return 'bottom';
  if (left > quarter * 0.008 && right < left * 0.15) return 'right';
  return 'none';
}

// ---- 生成 PDF ----
export async function buildIdCardPdf(
  cards: IdCardSource[],
  opts: IdCardOptions,
): Promise<Uint8Array> {
  if (!cards.length) throw new Error('请先添加身份证照片');
  const ordered = sortCards(cards);
  const pages = layoutPlacements(ordered.length, opts.perPage, opts.gapMm);
  const pdf = await PDFDocument.create();
  pdf.setTitle('身份证复印件（A4 · 实际尺寸）');
  pdf.setProducer('PDF Studio');
  pdf.setCreator('PDF Studio');

  let font: PDFFont | null = null;
  if (opts.label) {
    try {
      const res = await fetch('/ocr/fonts/NotoSansCJKsc-Regular.otf');
      if (res.ok) {
        pdf.registerFontkit(fontkit);
        font = await pdf.embedFont(new Uint8Array(await res.arrayBuffer()), { subset: true });
      }
    } catch { /* 字体缺失时静默跳过标签 */ }
  }

  for (const group of pages) {
    const page = pdf.addPage([A4_W, A4_H]);
    for (const p of group) {
      const card = ordered[p.index];
      const canvas = renderCardCanvas(card);
      const jpg = await pdf.embedJpg(canvas.toDataURL('image/jpeg', opts.quality));
      // 关键：物理尺寸只由这里的 width/height 决定，与图片像素、DPI 无关
      // 只放证件图像本身，不画外框（边框会在带白边的照片外再套一圈线框）
      page.drawImage(jpg, { x: p.x, y: p.y, width: p.width, height: p.height });
      if (font) {
        try {
          page.drawText(SIDE_LABEL[card.side], {
            x: p.x, y: p.y + p.height + 6, size: 8, font,
            color: rgb(0.4, 0.43, 0.48),
          });
        } catch { /* 忽略个别无法编码的字符 */ }
      }
    }
  }
  return pdf.save({ useObjectStreams: true });
}
