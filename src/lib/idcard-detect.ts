/**
 * 身份证区域自动定位 —— 纯前端、零依赖。
 *
 * 照片/扫描件里证件往往只占中间一小块，直接 cover 铺满 85.6×54mm
 * 会把证件放大到只剩一条窄带。这里先用像素分析找出卡片矩形，再按
 * 1.5852 的真实比例裁出，预览与 PDF 共用同一份结果。
 *
 * analyzePixels 不依赖 DOM，便于独立测试；其余部分负责取像素、旋转归一化与裁剪几何。
 */
import { CARD_RATIO } from './idcard-const';

/** 归一化裁剪框，w/h 的物理比例恒等于 CARD_RATIO */
export interface CropRect { x: number; y: number; w: number; h: number }
export type Rotation = 0 | 90 | 180 | 270;

export interface RawPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array; // RGBA
}

export interface Analysis {
  rect: CropRect;
  quality: number;   // 0..1，越高越像「背景 + 一张卡片」
  fit: number;       // 前景外接框比例与 1.5852 的贴合度
  rawRatio: number;  // 前景外接框的物理宽高比
}

export interface DetectResult extends Analysis {
  rotation: Rotation;  // 把竖着拍的证件转正
  located: boolean;    // false = 退化为最小裁切，需人工确认
  reason: string;
}

export interface ImageLike {
  width: number;
  height: number;
  naturalWidth?: number;
  naturalHeight?: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const MAX_BASE = 2400;      // 归一化画布最长边，85.6mm@300dpi≈1011px
const MAX_ANALYZE = 760;           // 分析用缩略图最长边
const CELL = 8;                    // 前景网格边长（px）

/** 归一化坐标下满足物理比例 R 的 w/h；width/height 为当前画布像素尺寸 */
export function cropRatio(width: number, height: number): number {
  return CARD_RATIO * height / width;
}

/** 最大子段和：从投影里找出前景最密集的连续区间，允许短断裂 */
function bestSegment(arr: number[], penalty: number) {
  let cur = 0, start = 0, bestV = -Infinity, bs = 0, be = arr.length;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] - penalty;
    if (cur <= 0) { cur = v; start = i; } else cur += v;
    if (cur > bestV) { bestV = cur; bs = start; be = i + 1; }
  }
  if (bestV === -Infinity || be <= bs) return { s: 0, e: arr.length };
  return { s: bs, e: be };
}

/**
 * 单方向像素分析：背景色估计 → 前景分数网格 → 行列投影 → 比例拟合 → 位置微调。
 * 身份证浅蓝/粉底纹（色差）、文字网纹（局部梯度）、饱和度都能贡献分数，
 * 白纸/纯色背景接近 0，因此能把卡片从大面积留白里挑出来。
 */
export function analyzePixels(px: RawPixels, targetRatio = CARD_RATIO): Analysis {
  const W = Math.max(1, px.width), H = Math.max(1, px.height), d = px.data;
  const gw = Math.max(1, Math.ceil(W / CELL));
  const gh = Math.max(1, Math.ceil(H / CELL));
  const grid = new Float64Array(gw * gh);
  const count = new Float64Array(gw * gh);

  // 1) 背景色 = 外圈像素的通道中位数
  const sr: number[] = [], sg: number[] = [], sb: number[] = [];
  const step = Math.max(1, Math.floor(Math.min(W, H) / 110));
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      if (!(x < W * 0.07 || x > W * 0.93 || y < H * 0.07 || y > H * 0.93)) continue;
      const p = (y * W + x) * 4;
      sr.push(d[p]); sg.push(d[p + 1]); sb.push(d[p + 2]);
    }
  }
  const median = (a: number[]) => { a.sort((m, n) => m - n); return a.length ? a[a.length >> 1] : 255; };
  const bg = [median(sr), median(sg), median(sb)];

  // 2) 前景分数网格
  const lum = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    lum[i] = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;
  }
  for (let y = 0; y < H; y++) {
    const gy = (y / CELL) | 0;
    const downY = Math.min(y + 2, H - 1) * W;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const dc = Math.max(
        Math.abs(d[p] - bg[0]), Math.abs(d[p + 1] - bg[1]), Math.abs(d[p + 2] - bg[2]),
      ) / 255;
      const i = y * W + x;
      const grad = (Math.abs(lum[y * W + Math.min(x + 2, W - 1)] - lum[i])
        + Math.abs(lum[downY + x] - lum[i])) / 2;
      const mx = Math.max(d[p], d[p + 1], d[p + 2]);
      const mn = Math.min(d[p], d[p + 1], d[p + 2]);
      const sat = mx > 0 ? (mx - mn) / mx : 0;
      const s = Math.min(1, Math.max(dc * 2.0, grad * 5.0, sat * 0.85));
      const gi = gy * gw + ((x / CELL) | 0);
      grid[gi] += s;
      count[gi]++;
    }
  }
  let total = 0;
  for (let i = 0; i < grid.length; i++) {
    if (count[i]) grid[i] /= count[i];
    total += grid[i];
  }
  const mean = total / grid.length;
  const th = clamp(mean * 1.7 + 0.035, 0.06, 0.30);
  const mask = new Uint8Array(grid.length);
  for (let i = 0; i < grid.length; i++) mask[i] = grid[i] > th ? 1 : 0;

  // 边缘也有内容 = 证件特写（整图就是卡片），此时不需要找背景里的矩形
  let borderSum = 0, borderN = 0;
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (x < 2 || x >= gw - 2 || y < 2 || y >= gh - 2) {
        borderSum += grid[y * gw + x]; borderN++;
      }
    }
  }
  const borderMean = borderSum / Math.max(1, borderN);
  if (mean > 0.04 && borderMean > mean * 0.60) {
    const r = cropRatio(W, H);
    let w = Math.min(1, r), h = w / r;
    if (h > 1) { h = 1; w = h * r; }
    return {
      rect: { x: (1 - w) / 2, y: (1 - h) / 2, w, h },
      quality: 0.80,
      fit: clamp(1 - Math.abs(Math.log((W / H) / targetRatio)) / Math.log(2.2), 0, 1),
      rawRatio: W / H,
    };
  }

  // 积分图，供区域求和 O(1)
  const it = new Float64Array((gw + 1) * (gh + 1));
  for (let y = 0; y < gh; y++) {
    let row = 0;
    for (let x = 0; x < gw; x++) {
      row += grid[y * gw + x];
      it[(y + 1) * (gw + 1) + x + 1] = it[y * (gw + 1) + x + 1] + row;
    }
  }
  const area = (x0: number, y0: number, x1: number, y1: number) =>
    it[y1 * (gw + 1) + x1] - it[y0 * (gw + 1) + x1]
    - it[y1 * (gw + 1) + x0] + it[y0 * (gw + 1) + x0];

  // 3) 行列投影 → 前景主体外接框
  const colCnt = new Float64Array(gw), rowCnt = new Float64Array(gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (mask[y * gw + x]) { colCnt[x]++; rowCnt[y]++; }
    }
  }
  const sx = bestSegment(Array.from(colCnt), gh * 0.14);
  const sy = bestSegment(Array.from(rowCnt), gw * 0.14);
  let bx0 = clamp(sx.s - 1, 0, gw - 1), bx1 = clamp(sx.e + 1, 1, gw);
  let by0 = clamp(sy.s - 1, 0, gh - 1), by1 = clamp(sy.e + 1, 1, gh);
  if (bx1 - bx0 < gw * 0.16) { bx0 = 0; bx1 = gw; }
  if (by1 - by0 < gh * 0.16) { by0 = 0; by1 = gh; }
  const bw = bx1 - bx0, bh = by1 - by0;
  const rawRatio = (W * bw / gw) / Math.max(1e-6, H * bh / gh);
  const fit = clamp(1 - Math.abs(Math.log(rawRatio / targetRatio)) / Math.log(2.2), 0, 1);

  // 4) 按目标比例拟合（网格格子近似正方形，故目标网格宽高比 ≈ R），并限制在图内
  const tRatio = targetRatio * (H / W) * (gw / gh);
  let cw = Math.max(bw, bh * tRatio) * 1.06;
  let ch = cw / tRatio;
  const k = Math.min(1, gw / cw, gh / ch);
  cw *= k; ch *= k;
  const centerX = (bx0 + bx1) / 2, centerY = (by0 + by1) / 2;

  // 5) 边缘精修：在初值附近找「留白 → 卡片」分数跳变最陡的四条边。
  //    投影段常把阴影算进来，直接拟合会让证件在 PDF 里偏小；贴住边界才能保住实尺。
  const colMean = new Float64Array(gw), rowMean = new Float64Array(gh);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      colMean[x] += grid[y * gw + x];
      rowMean[y] += grid[y * gw + x];
    }
  }
  for (let x = 0; x < gw; x++) colMean[x] /= gh;
  for (let y = 0; y < gh; y++) rowMean[y] /= gw;
  const smooth = (a: Float64Array) => {
    const o = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
      o[i] = (a[Math.max(0, i - 1)] + a[i] + a[Math.min(a.length - 1, i + 1)]) / 3;
    }
    return o;
  };
  const cm = smooth(colMean), rm = smooth(rowMean);
  const findEdge = (a: Float64Array, center: number, span: number, sign: number) => {
    let bi = center, bv = -Infinity;
    const lo = Math.max(1, Math.round(center - span));
    const hi = Math.min(a.length - 2, Math.round(center + span));
    for (let i = lo; i <= hi; i++) {
      const v = sign * (a[i + 1] - a[i - 1]);
      if (v > bv) { bv = v; bi = i; }
    }
    return bi;
  };
  const spanX = Math.max(3, Math.round(gw * 0.14));
  const spanY = Math.max(3, Math.round(gh * 0.14));
  let L = centerX - cw / 2, R = centerX + cw / 2;
  let T = centerY - ch / 2, B = centerY + ch / 2;
  const eL = findEdge(cm, L, spanX, +1), eR = findEdge(cm, R, spanX, -1);
  const eT = findEdge(rm, T, spanY, +1), eB = findEdge(rm, B, spanY, -1);
  if (eR - eL >= gw * 0.18) { L = eL; R = eR; }
  if (eB - eT >= gh * 0.18) { T = eT; B = eB; }
  cw = Math.max(R - L, (B - T) * tRatio) * 0.99;
  ch = cw / tRatio;
  const k2 = Math.min(1, gw / cw, gh / ch);
  cw *= k2; ch *= k2;
  const ecx = (L + R) / 2, ecy = (T + B) / 2;
  const bestX = clamp(ecx - cw / 2, 0, gw - cw);
  const bestY = clamp(ecy - ch / 2, 0, gh - ch);

  // 6) 换算回归一化坐标；用 cropRatio 保证物理宽高比精确等于 R
  const r = cropRatio(W, H);
  let rw = clamp(cw / gw, 0.02, 1);
  let rh = rw / r;
  if (rh > 1) { rh = 1; rw = rh * r; }
  const rect: CropRect = {
    x: clamp(bestX / gw, 0, 1 - rw),
    y: clamp(bestY / gh, 0, 1 - rh),
    w: rw, h: rh,
  };

  // 7) 质量评估
  const rx0 = Math.round(rect.x * gw), ry0 = Math.round(rect.y * gh);
  const rx1 = Math.min(gw, Math.round((rect.x + rect.w) * gw));
  const ry1 = Math.min(gh, Math.round((rect.y + rect.h) * gh));
  const win = Math.max(1, (rx1 - rx0) * (ry1 - ry0));
  const s = area(rx0, ry0, rx1, ry1);
  const inside = s / win;
  const outside = (total - s) / Math.max(1, gw * gh - win);
  let dense = 0;
  for (let gy = ry0; gy < ry1; gy++) for (let gx = rx0; gx < rx1; gx++) dense += mask[gy * gw + gx];
  dense /= win;
  const coverage = win / (gw * gh);
  let quality = clamp((inside - outside) * 4, 0, 1) * clamp(dense * 1.6, 0, 1);
  // 整图就是证件特写时内外对比天然为 0，但前景密度高，应视为成功
  if (coverage > 0.72 && dense > 0.55) quality = Math.max(quality, 0.7);
  return { rect, quality, fit, rawRatio };
}

/** 把图片按指定角度画到画布，顺带限制最长边以控制内存 */
export function drawRotated(
  image: ImageLike, rotation: Rotation, maxSide = MAX_BASE, doc: Document = document,
): HTMLCanvasElement {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  const k = Math.min(1, maxSide / Math.max(iw, ih, 1));
  const w = Math.max(1, Math.round(iw * k));
  const h = Math.max(1, Math.round(ih * k));
  const swap = rotation === 90 || rotation === 270;
  const canvas = doc.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.save();
  if (rotation === 90) { ctx.translate(canvas.width, 0); ctx.rotate(Math.PI / 2); }
  else if (rotation === 180) { ctx.translate(canvas.width, canvas.height); ctx.rotate(Math.PI); }
  else if (rotation === 270) { ctx.translate(0, canvas.height); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(image as CanvasImageSource, 0, 0, w, h);
  ctx.restore();
  return canvas;
}

/** 角度规整：限制到 ±180°，保留两位小数，非法值归零 */
export function clampAngle(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.round(clamp(v, -180, 180) * 100) / 100;
}

/**
 * 手写角度是否该走整步正交旋转：90° 的整数倍（0 除外）返回 ±1 / ±2 步，
 * 其余返回 0 交给自由微调。整步会交换画布宽高并重新定位证件，
 * 直接做自由旋转会让横向取景框套在竖图上。
 */
export function orthoSteps(v: number): number {
  const a = clampAngle(v);
  return a !== 0 && a % 90 === 0 ? a / 90 : 0;
}

/** 取四角小块的平均色，用来填补自由旋转后露出的三角形区域 */
function edgeColor(source: HTMLCanvasElement): string {
  const ctx = source.getContext('2d', { willReadFrequently: true });
  if (!ctx) return '#ffffff';
  const W = source.width, H = source.height;
  const s = Math.max(1, Math.min(12, Math.round(Math.min(W, H) / 60)));
  let r = 0, g = 0, b = 0, n = 0;
  const spots: [number, number][] = [[0, 0], [W - s, 0], [0, H - s], [W - s, H - s]];
  for (const [x, y] of spots) {
    try {
      const data = ctx.getImageData(x, y, s, s).data;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    } catch { /* 画布被跨域污染时退回白色 */ }
  }
  return n ? `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})` : '#ffffff';
}

/**
 * 自由角度旋转：画布尺寸与归一化坐标系保持不变，因此取景框 crop 可以直接沿用。
 * canvas 的 y 轴向下，故正角度顺时针（右转）、负角度逆时针（左转）。
 * 不放大也不裁切证件内容：旋转后露出的四角用原图边缘色填充，
 * 复印件本来就印在白纸上，这几个小三角不会显得突兀。
 */
export function rotateFree(
  source: HTMLCanvasElement, angle: number, doc: Document = document,
): HTMLCanvasElement {
  const a = clampAngle(angle);
  if (a === 0) return source;
  const W = source.width, H = source.height;
  const out = doc.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.fillStyle = edgeColor(source);
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(a * Math.PI / 180);
  ctx.drawImage(source, -W / 2, -H / 2);
  ctx.restore();
  return out;
}

/** 对「已经按 rotation 旋转好的图」做一次单方向分析 */
export function analyzeImage(
  image: ImageLike, rotation: Rotation = 0, doc: Document = document,
): Analysis {
  const thumb = drawRotated(image, rotation, MAX_ANALYZE, doc);
  const ctx = thumb.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法读取图片像素');
  const px = ctx.getImageData(0, 0, thumb.width, thumb.height);
  return analyzePixels(px);
}

/** 自动定位：比较 0° / 90° 两个方向。
 *  方向误判会把横向证件转成竖向再裁成横框，画面就只剩半张，因此：
 *  ① 0° 已找到比例正确的横向矩形时直接锁定 0°；② 其余情况给 0° 明显先验。
 */
export function detectCardRect(image: ImageLike, doc: Document = document): DetectResult {
  const results = ([0, 90] as Rotation[]).map((rotation) => ({
    rotation, a: analyzeImage(image, rotation, doc),
  }));
  const score = (c: typeof results[number]) =>
    c.a.quality * 0.62 + c.a.fit * 0.38 + (c.rotation === 0 ? 0.22 : 0);
  const a0 = results[0].a;
  const best = (a0.fit >= 0.70 && a0.quality >= 0.15)
    ? results[0]
    : results.reduce((p, c) => (score(c) > score(p) ? c : p));
  const { rotation, a } = best;
  const located = a.quality >= 0.16 && (a.fit >= 0.15 || a.quality >= 0.45);
  const thumbW = rotation === 90 ? image.naturalHeight || image.height : image.naturalWidth || image.width;
  const thumbH = rotation === 90 ? image.naturalWidth || image.width : image.naturalHeight || image.height;
  // 低置信度时仍沿用检测框（整图兜底会把证件缩成一小块），只在完全读不到内容时退化
  const rect = a.quality < 0.08 ? minimalCrop(thumbW, thumbH) : a.rect;
  return {
    ...a, rect, rotation, located,
    reason: !located
      ? '定位置信度偏低，请在「原图框选」里确认取景框'
      : rotation === 90 ? '已自动定位并把竖拍证件转正' : '已自动定位证件区域',
  };
}

/** 最小裁切兜底：cover 到 1.5852 比例，但绝不放大到只剩局部 */
export function minimalCrop(width: number, height: number): CropRect {
  const r = cropRatio(width, height);
  let w = Math.min(1, r), h = w / r;
  if (h > 1) { h = 1; w = h * r; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/** 缩放取景框：factor<1 放大（框变小），>1 缩小；保持比例与中心且不越界 */
export function zoomCrop(c: CropRect, factor: number, width: number, height: number): CropRect {
  const r = cropRatio(width, height);
  let w = clamp(c.w * factor, 0.08, 1);
  let h = w / r;
  if (h > 1) { h = 1; w = h * r; }
  const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
  return {
    x: clamp(cx - w / 2, 0, 1 - w),
    y: clamp(cy - h / 2, 0, 1 - h),
    w, h,
  };
}

/** 拖动取景：dx/dy 为归一化视口位移（向右拖则显示更靠左的内容） */
export function panCrop(c: CropRect, dx: number, dy: number): CropRect {
  return {
    ...c,
    x: clamp(c.x - dx * c.w, 0, 1 - c.w),
    y: clamp(c.y - dy * c.h, 0, 1 - c.h),
  };
}

/** 拖动「取景框本身」：dx/dy 为归一化位移，框随指针同向移动 */
export function moveCrop(c: CropRect, dx: number, dy: number): CropRect {
  return { ...c, x: clamp(c.x + dx, 0, 1 - c.w), y: clamp(c.y + dy, 0, 1 - c.h) };
}

/** 按比例改变取景框宽度；anchor=start 时左上角固定，center 时中心固定 */
export function resizeCrop(
  c: CropRect, newW: number, width: number, height: number,
  anchor: 'center' | 'start' = 'center',
): CropRect {
  const r = cropRatio(width, height);
  let w = clamp(newW, 0.08, 1);
  let h = w / r;
  if (h > 1) { h = 1; w = h * r; }
  const cx = anchor === 'center' ? c.x + c.w / 2 : c.x;
  const cy = anchor === 'center' ? c.y + c.h / 2 : c.y;
  return {
    x: anchor === 'center' ? clamp(cx - w / 2, 0, 1 - w) : clamp(cx, 0, 1 - w),
    y: anchor === 'center' ? clamp(cy - h / 2, 0, 1 - h) : clamp(cy, 0, 1 - h),
    w, h,
  };
}

/** 整图按 contain 放进视口后的布局，供框选编辑器做屏幕坐标 ↔ 归一化坐标换算 */
export function containLayout(viewW: number, viewH: number, imgW: number, imgH: number) {
  const s = Math.min(viewW / Math.max(1, imgW), viewH / Math.max(1, imgH));
  const dw = imgW * s, dh = imgH * s;
  return { s, dw, dh, ox: (viewW - dw) / 2, oy: (viewH - dh) / 2 };
}
