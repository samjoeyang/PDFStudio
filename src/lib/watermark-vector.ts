/**
 * 矢量水印：以 PDF 原生文本 / 图像层叠加水印，保留原页面文字可选中、可搜索，
 * 且文件体积远小于栅格化方案。
 *
 * 与 `watermark.ts` 的 `drawWatermark`（画在 canvas → 整页转图）互补：
 * 这里直接操作 pdf-lib 页面内容流，因此不会破坏原页的矢量与文字层。
 *
 * 坐标系要点（与 canvas 预览镜像）：
 * - pdf-lib 页面原点在左下角，y 轴向上；canvas 原点在左上角，y 轴向下。
 * - 为了与预览旋转方向一致，文本自身的旋转取 `-rotation`，
 *   平铺偏移则按 canvas 的旋转矩阵算出后做 y 轴镜像。
 */

import { PDFDocument, rgb, degrees } from 'pdf-lib';
import type { PDFFont, PDFImage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { tileOffsets } from './watermark';
import type { WatermarkSettings } from './watermark';

/** 思源黑体（Noto Sans CJK SC），与 OCR / 身份证排版共用，离线可用 */
const FONT_URL = '/ocr/fonts/NotoSansCJKsc-Regular.otf';

export async function loadWatermarkFont(): Promise<Uint8Array> {
  const res = await fetch(FONT_URL);
  if (!res.ok) throw new Error('水印字体加载失败');
  return new Uint8Array(await res.arrayBuffer());
}

function hexToRgb(hex: string) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

function clampOpacity(v: number): number {
  return Math.max(0.02, Math.min(1, v));
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1] ?? '';
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/**
 * 计算单个水印瓦片在 PDF 页面里的绘制左下角与旋转角。
 * 输入 t.* 是相对页面中心、处于「已旋转坐标系」的偏移（与 canvas 预览同义）。
 */
function placement(
  W: number,
  H: number,
  t: { x: number; y: number },
  w: number,
  h: number,
  rotationDeg: number,
): { x: number; y: number; rotateDeg: number } {
  const r = rotationDeg * Math.PI / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // canvas 旋转后相对中心的偏移
  const oxc = t.x * cos - t.y * sin;
  const oyc = t.x * sin + t.y * cos;
  // 镜像到 PDF（y 轴翻转）：绝对中心
  const Cx = W / 2 + oxc;
  const Cy = H / 2 - oyc;
  // 文本自身旋转取反，使视觉与 canvas 预览一致
  const a = -rotationDeg;
  const ar = a * Math.PI / 180;
  const ac = Math.cos(ar);
  const as = Math.sin(ar);
  const x = Cx - (w / 2) * ac - (h / 2) * as;
  const y = Cy + (w / 2) * as - (h / 2) * ac;
  return { x, y, rotateDeg: a };
}

/**
 * 在「不会被栅格化」的页面上叠加矢量水印。
 * pageIndices 为 0-based 页面序号（导出后的页序）。
 * 文字水印需传入 fontBytes；图片水印忽略之。
 */
export async function applyVectorWatermark(
  bytes: Uint8Array,
  s: WatermarkSettings,
  pageIndices: number[],
  fontBytes?: Uint8Array,
): Promise<Uint8Array> {
  if (!s.enabled || pageIndices.length === 0) return bytes;

  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

  let font: PDFFont | undefined;
  let image: PDFImage | undefined;
  let naturalRatio = 1;

  if (s.kind === 'text') {
    if (!fontBytes) throw new Error('矢量文字水印需要嵌入字体');
    pdfDoc.registerFontkit(fontkit);
    font = await pdfDoc.embedFont(fontBytes, { subset: true });
  } else if (s.image) {
    const u8 = dataUrlToBytes(s.image);
    if (s.image.includes('image/png')) image = await pdfDoc.embedPng(u8);
    else image = await pdfDoc.embedJpg(u8);
    naturalRatio = image.height / Math.max(1, image.width);
  } else {
    return bytes; // 图片水印无图，静默跳过
  }

  const label = (s.text || '').trim() || '水印';
  const opacity = clampOpacity(s.opacity);
  const color = hexToRgb(s.color);

  for (const idx of pageIndices) {
    const page = pdfDoc.getPage(idx);
    const W = page.getWidth();
    const H = page.getHeight();
    if (!W || !H) continue;

    const size = Math.max(8, W * s.fontSize / 600);
    let w = 0;
    let h = 0;
    if (s.kind === 'text' && font) {
      w = Math.max(20, font.widthOfTextAtSize(label, size));
      h = size * 1.35;
    } else if (image) {
      w = Math.max(16, W * s.scale);
      h = w * naturalRatio;
    } else {
      continue;
    }

    const tiles = s.tiled
      ? tileOffsets(W, H, w, h, s.gap, s.rotation)
      : [{ x: 0, y: 0 }];

    for (const t of tiles) {
      const { x, y, rotateDeg } = placement(W, H, t, w, h, s.rotation);
      if (s.kind === 'text' && font) {
        page.drawText(label, {
          x, y, size, font, color, opacity, rotate: degrees(rotateDeg),
        });
      } else if (image) {
        page.drawImage(image, {
          x, y, width: w, height: h, opacity, rotate: degrees(rotateDeg),
        });
      }
    }
  }

  return pdfDoc.save({ useObjectStreams: true });
}
