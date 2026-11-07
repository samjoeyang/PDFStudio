/**
 * 水印绘制核心：预览面板与导出链路共用同一个函数，保证所见即所得。
 *
 * 水印一律画在「已渲染好的页面 canvas」上，中文直接用系统字体，
 * 不需要给 pdf-lib 嵌入字体或做字形子集；代价是带水印的页会栅格化
 * （与批注页一致），文字层随之消失。
 */

export type WatermarkKind = 'text' | 'image';
export type WatermarkScope = 'all' | 'selected';

export interface WatermarkSettings {
  enabled: boolean;
  kind: WatermarkKind;
  text: string;
  /** 图片水印的 dataURL */
  image?: string;
  /** 字号（pt 概念），按 600pt 页宽归一化后换算成画布像素 */
  fontSize: number;
  color: string;
  /** 0.05 ~ 1 */
  opacity: number;
  /** 旋转角度，度 */
  rotation: number;
  tiled: boolean;
  /** 平铺步长为水印自身尺寸的倍数 */
  gap: number;
  /** 图片水印宽度占页面宽度的比例 */
  scale: number;
  scope: WatermarkScope;
}

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: false,
  kind: 'text',
  text: '机密 · 仅供内部使用',
  fontSize: 36,
  color: '#64748b',
  opacity: 0.18,
  rotation: -30,
  tiled: true,
  gap: 1.6,
  scale: 0.28,
  scope: 'all',
};

const FONT_STACK = '-apple-system, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('水印图片加载失败'));
    img.src = src;
  });
}

/**
 * 平铺中心点（相对页面中心，处于「已旋转」的坐标系）。
 * 抽成纯函数便于在 Node 里校验覆盖范围：旋转后画布的包围盒会变大，
 * 直接按原宽高铺会在四角留下空白。
 */
export function tileOffsets(
  pageW: number,
  pageH: number,
  tileW: number,
  tileH: number,
  gap: number,
  rotationDeg: number,
): Array<{ x: number; y: number }> {
  const rad = rotationDeg * Math.PI / 180;
  const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
  const spanW = c * pageW + s * pageH;
  const spanH = s * pageW + c * pageH;
  const stepX = Math.max(8, tileW * Math.max(1, gap));
  const stepY = Math.max(8, tileH * Math.max(1, gap));
  const cols = Math.ceil(spanW / stepX) + 2;
  const rows = Math.ceil(spanH / stepY) + 2;
  const out: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      out.push({
        x: (col - (cols - 1) / 2) * stepX,
        y: (r - (rows - 1) / 2) * stepY,
      });
    }
  }
  return out;
}

/** 在页面画布上叠加水印；图片无效时静默跳过，不阻断导出 */
export async function drawWatermark(
  canvas: HTMLCanvasElement,
  s: WatermarkSettings,
): Promise<void> {
  if (!s.enabled) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const W = canvas.width, H = canvas.height;
  if (!W || !H) return;

  const label = (s.text || '').trim() || '水印';
  const fontPx = Math.max(10, W * s.fontSize / 600);
  const font = `600 ${fontPx}px ${FONT_STACK}`;
  let image: HTMLImageElement | null = null;
  let boxW = 0, boxH = 0;

  if (s.kind === 'image' && s.image) {
    try { image = await loadImage(s.image); } catch { return; }
    boxW = Math.max(16, W * s.scale);
    boxH = Math.max(8, boxW * image.naturalHeight / Math.max(1, image.naturalWidth));
  } else {
    ctx.save();
    ctx.font = font;
    boxW = Math.max(20, ctx.measureText(label).width);
    boxH = fontPx * 1.35;
    ctx.restore();
  }

  ctx.save();
  ctx.globalAlpha = Math.max(0.02, Math.min(1, s.opacity));
  ctx.translate(W / 2, H / 2);
  ctx.rotate(s.rotation * Math.PI / 180);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = s.color;

  const paint = (cx: number, cy: number) => {
    if (image) ctx.drawImage(image, cx - boxW / 2, cy - boxH / 2, boxW, boxH);
    else ctx.fillText(label, cx, cy);
  };

  if (s.tiled) {
    for (const o of tileOffsets(W, H, boxW, boxH, s.gap, s.rotation)) paint(o.x, o.y);
  } else {
    paint(0, 0);
  }
  ctx.restore();
}
