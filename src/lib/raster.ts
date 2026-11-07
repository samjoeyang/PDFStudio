import { PDFDocument, rgb, degrees, PDFName } from 'pdf-lib';
import { loadPdfJsDoc, renderPageToCanvas } from './thumb';
import type { Annotation } from './types';
import { drawWatermark } from './watermark';
import type { WatermarkSettings } from './watermark';

type Overlays = Map<number, Annotation[]>;
type Progress = (done: number, total: number) => void;

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('签名图片加载失败'));
    img.src = src;
  });
}

/** 把批注画到已渲染好的页面 canvas 上（canvas 2D 原生支持中文） */
export async function drawAnnotations(canvas: HTMLCanvasElement, anns: Annotation[]): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width;
  const H = canvas.height;

  // 遮挡永远最后绘制，确保不会被其它批注盖住而重新露出内容
  const ordered = [
    ...anns.filter((a) => a.type !== 'mask'),
    ...anns.filter((a) => a.type === 'mask'),
  ];
  for (const a of ordered) {
    const x = a.x * W;
    const y = a.y * H;
    const w = a.w * W;
    const h = a.h * H;

    if (a.type === 'mask') {
      ctx.save();
      ctx.fillStyle = a.color || '#111111';
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    } else if (a.type === 'highlight') {
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = a.color;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    } else if (a.type === 'text') {
      const fontSize = Math.max(13, Math.round(H * 0.016));
      const lines = (a.text ?? '').split('\n');
      ctx.save();
      ctx.font = `500 ${fontSize}px -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif`;
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width), 40);
      const boxW = Math.max(w, widest + 14);
      const boxH = lines.length * fontSize * 1.4 + 12;
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillRect(x, y, boxW, boxH);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, boxW, boxH);
      ctx.fillStyle = a.color;
      lines.forEach((line, i) => ctx.fillText(line, x + 7, y + fontSize + 4 + i * fontSize * 1.4));
      ctx.restore();
    } else if (a.type === 'signature' && a.image) {
      try {
        const img = await loadImage(a.image);
        ctx.drawImage(img, x, y, w, h);
      } catch { /* 跳过无效图片 */ }
    } else if (a.type === 'ink') {
      ctx.save();
      ctx.strokeStyle = a.color;
      ctx.lineWidth = Math.max(2, W * 0.0035);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const stroke of a.strokes ?? []) {
        if (stroke.points.length < 2) continue;
        ctx.beginPath();
        stroke.points.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x * W, p.y * H);
          else ctx.lineTo(p.x * W, p.y * H);
        });
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

/** 导出时叠加的页面层：水印设置 + 需要加水印的页索引（0-based） */
export interface PageLayers {
  watermark?: WatermarkSettings;
  watermarkPages?: Set<number>;
}

/** 批注在前、水印在后：水印覆盖整页，不应被页面内容或其它批注压住 */
async function paintLayers(
  canvas: HTMLCanvasElement,
  anns: Annotation[],
  layers?: PageLayers,
  hasWatermark = false,
): Promise<void> {
  if (anns.length) await drawAnnotations(canvas, anns);
  if (hasWatermark && layers?.watermark?.enabled) {
    await drawWatermark(canvas, layers.watermark);
  }
}

/**
 * 只把带批注的页栅格化并覆盖写回，其余页保持原始矢量内容。
 * 旋转会被烘焙进图片，页面外观与工作区一致。
 * 被栅格化的页会清空原内容流：旧文字对象既看不见也不该被复制出来，
 * 含遮挡（mask）的页因此实现真正的脱敏，而非仅仅视觉遮盖。
 */
export async function applyAnnotations(
  baseBytes: Uint8Array,
  overlays: Overlays,
  onProgress?: Progress,
  layers?: PageLayers,
): Promise<Uint8Array> {
  // 水印页即便没有批注也要进入栅格化集合
  const targets = new Set<number>(overlays.keys());
  layers?.watermarkPages?.forEach((i) => targets.add(i));
  if (!targets.size) return baseBytes;
  const out = await PDFDocument.load(baseBytes);
  const doc = await loadPdfJsDoc(baseBytes);
  const entries: Array<[number, Annotation[]]> = [...targets]
    .sort((a, b) => a - b)
    .map((i) => [i, overlays.get(i) ?? []]);
  try {
    for (let i = 0; i < entries.length; i++) {
      const [idx, anns] = entries[i];
      const canvas = await renderPageToCanvas(doc, idx + 1, 2);
      await paintLayers(canvas, anns, layers, layers?.watermarkPages?.has(idx) ?? false);
      const jpg = await out.embedJpg(canvas.toDataURL('image/jpeg', 0.92));
      const viewport = (await doc.getPage(idx + 1)).getViewport({ scale: 1 });
      const page = out.getPage(idx);
      page.setRotation(degrees(0));
      page.setSize(viewport.width, viewport.height);
      // 页面已整页栅格化，原内容流只剩「看不见却能被复制出来」的旧文字对象；
      // 统一清空：体积更小，遮挡页也能做到真正脱敏。
      page.node.delete(PDFName.of('Contents'));
      page.drawRectangle({
        x: 0, y: 0, width: viewport.width, height: viewport.height, color: rgb(1, 1, 1),
      });
      page.drawImage(jpg, {
        x: 0, y: 0, width: viewport.width, height: viewport.height,
      });
      onProgress?.(i + 1, entries.length);
    }
  } finally {
    await doc.destroy();
  }
  return out.save({ useObjectStreams: true });
}

/** 全页栅格化：真正的图像重编码压缩，扫描件体积可下降一个数量级 */
export async function rasterizePdf(
  baseBytes: Uint8Array,
  opts: { dpi: number; quality: number },
  overlays?: Overlays,
  onProgress?: Progress,
  layers?: PageLayers,
): Promise<Uint8Array> {
  const src = await loadPdfJsDoc(baseBytes);
  const out = await PDFDocument.create();
  try {
    const total = src.numPages;
    for (let i = 1; i <= total; i++) {
      const viewport = (await src.getPage(i)).getViewport({ scale: 1 });
      const canvas = await renderPageToCanvas(src, i, opts.dpi / 72);
      const anns = overlays?.get(i - 1) ?? [];
      await paintLayers(canvas, anns, layers, layers?.watermarkPages?.has(i - 1) ?? false);
      const jpg = await out.embedJpg(canvas.toDataURL('image/jpeg', opts.quality));
      const page = out.addPage([viewport.width, viewport.height]);
      page.drawImage(jpg, {
        x: 0, y: 0, width: viewport.width, height: viewport.height,
      });
      onProgress?.(i, total);
    }
  } finally {
    await src.destroy();
  }
  return out.save({ useObjectStreams: true });
}
