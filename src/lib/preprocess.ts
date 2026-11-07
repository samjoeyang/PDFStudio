/**
 * OCR 图像预处理：纯像素算法，不依赖任何 DOM / 第三方库。
 * 浏览器端通过 processCanvas() 调用，Node 端可直接对 RGBA 数据做同样的测试。
 *
 * 关键手段：
 *  - 灰度化 + 自适应对比度拉伸（低对比度扫描件）
 *  - 3×3 中值去噪（噪点、颗粒感）
 *  - Sauvola 局部自适应二值化（拍照阴影、光照不均）
 *  - 投影法自动纠偏（±5° 内的倾斜）
 */

export type PreprocessMode = 'auto' | 'gray' | 'binary' | 'none';

export interface GrayImage {
  width: number;
  height: number;
  /** 单通道灰度，长度 = width * height */
  data: Uint8ClampedArray;
}

export interface ImageStats {
  hi: number;
  lo: number;
  contrast: number;
  uneven: number;
  noise: number;
  angle: number;
  inverted: boolean;
  /** 识别前实际使用的放大倍数（1 表示未放大） */
  upscale: number;
}

export interface PreprocessResult {
  image: GrayImage;
  /** 实际采用的模式（auto 会自动判定） */
  applied: Exclude<PreprocessMode, 'auto'>;
  stats: ImageStats;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\u3000-\u303f\uff00-\uffef]/;
/** 小图自动放大阈值：宽度低于 1800px 且面积不超过 600 万像素时放大 2 倍 */
const AUTO_UPSCALE_WIDTH = 1800;
const AUTO_UPSCALE_MAX_AREA = 6_000_000;

export function rgbaToGray(rgba: Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { width, height, data };
}

export function grayToRgba(gray: GrayImage): Uint8ClampedArray {
  const out = new Uint8ClampedArray(gray.data.length * 4);
  for (let i = 0, p = 0; i < gray.data.length; i++, p += 4) {
    out[p] = out[p + 1] = out[p + 2] = gray.data[i];
    out[p + 3] = 255;
  }
  return out;
}

function histogram(g: Uint8ClampedArray): Uint32Array {
  const h = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) h[g[i]]++;
  return h;
}

function percentile(h: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += h[v];
    if (acc >= target) return v;
  }
  return 255;
}

/** 只统计样本，避免大图全量扫描 */
function sampleStats(gray: GrayImage) {
  const { width: w, height: h, data } = gray;
  const hst = new Uint32Array(256);
  let n = 0;
  const step = Math.max(1, Math.floor(data.length / 400000));
  for (let i = 0; i < data.length; i += step) { hst[data[i]]++; n++; }
  const hi = percentile(hst, n, 0.9);
  const lo = percentile(hst, n, 0.02);

  // 光照不均：比较九宫格「背景亮度」（各块最亮 20% 像素的均值）。
  // 不能直接比整块均值，否则文字密度差异会被误判成渐变。
  const blockW = Math.max(1, Math.floor(w / 3));
  const blockH = Math.max(1, Math.floor(h / 3));
  let minBg = 255, maxBg = 0;
  for (let by = 0; by < 3; by++) {
    for (let bx = 0; bx < 3; bx++) {
      const bh = new Uint32Array(256);
      let cnt = 0;
      const y0 = by * blockH, y1 = Math.min(h, (by + 1) * blockH);
      const x0 = bx * blockW, x1 = Math.min(w, (bx + 1) * blockW);
      for (let y = y0; y < y1; y += 4) {
        for (let x = x0; x < x1; x += 4) { bh[data[y * w + x]]++; cnt++; }
      }
      let acc = 0, sum = 0;
      const need = Math.max(1, Math.floor(cnt * 0.2));
      for (let v = 255; v >= 0 && acc < need; v--) {
        const take = Math.min(bh[v], need - acc);
        acc += take; sum += v * take;
      }
      const bg = acc ? sum / acc : 255;
      if (bg < minBg) minBg = bg;
      if (bg > maxBg) maxBg = bg;
    }
  }

  // 噪点：抽样像素与右/下邻居的差值均值
  let diff = 0, dc = 0;
  const s = Math.max(1, Math.floor(data.length / 200000));
  for (let i = 0; i + w + 1 < data.length; i += s) {
    diff += Math.abs(data[i] - data[i + 1]) + Math.abs(data[i] - data[i + w]);
    dc += 2;
  }
  return { hi, lo, contrast: hi - lo, uneven: maxBg - minBg, noise: dc ? diff / dc : 0 };
}

function stretchContrast(gray: GrayImage, lo: number, hi: number): void {
  if (hi - lo < 24) return;
  const scale = 255 / (hi - lo);
  const d = gray.data;
  for (let i = 0; i < d.length; i++) {
    d[i] = (d[i] - lo) * scale;
  }
}

/** 3×3 中值，去椒盐噪点同时尽量保留笔画边缘 */
function median3(gray: GrayImage): void {
  const { width: w, height: h, data } = gray;
  const src = data.slice();
  const buf = new Uint8ClampedArray(9);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = (y + dy) * w + x;
        buf[k++] = src[row - 1]; buf[k++] = src[row]; buf[k++] = src[row + 1];
      }
      // 9 个值的插入排序取中位
      for (let a = 1; a < 9; a++) {
        const v = buf[a]; let b = a - 1;
        while (b >= 0 && buf[b] > v) { buf[b + 1] = buf[b]; b--; }
        buf[b + 1] = v;
      }
      data[y * w + x] = buf[4];
    }
  }
}

/** Otsu 全局阈值 */
function otsu(gray: GrayImage): number {
  const h = histogram(gray.data);
  const total = gray.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * h[i];
  let wB = 0, sumB = 0, best = 0, threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += h[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * h[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; threshold = t; }
  }
  return threshold;
}

/**
 * Sauvola 局部自适应二值化。
 * 先在 1/4 缩略图上用积分图算局部均值与标准差，避免大图占用大量内存。
 */
function adaptiveBinarize(gray: GrayImage): void {
  const { width: w, height: h, data } = gray;
  const S = 4;
  const dw = Math.max(1, Math.ceil(w / S)), dh = Math.max(1, Math.ceil(h / S));
  const small = new Float32Array(dw * dh);
  const counts = new Uint16Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(dh - 1, y >> 2);
    for (let x = 0; x < w; x++) {
      const i = sy * dw + Math.min(dw - 1, x >> 2);
      small[i] += data[y * w + x];
      counts[i]++;
    }
  }
  for (let i = 0; i < small.length; i++) if (counts[i]) small[i] /= counts[i];

  // 积分图（均值、平方均值）
  const iw = dw + 1, ih = dh + 1;
  const isum = new Float64Array(iw * ih);
  const isq = new Float64Array(iw * ih);
  for (let y = 0; y < dh; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < dw; x++) {
      const v = small[y * dw + x];
      rs += v; rq += v * v;
      const i = (y + 1) * iw + (x + 1);
      isum[i] = isum[y * iw + (x + 1)] + rs;
      isq[i] = isq[y * iw + (x + 1)] + rq;
    }
  }
  const r = Math.max(2, Math.round(24 / S)); // 约 96px 的局部窗口
  const meanMap = new Float32Array(dw * dh);
  const sdMap = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(dh - 1, y + r);
    for (let x = 0; x < dw; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(dw - 1, x + r);
      const n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const a = (y1 + 1) * iw + x1 + 1, b = y0 * iw + x1 + 1;
      const c = (y1 + 1) * iw + x0, d = y0 * iw + x0;
      const sum = isum[a] - isum[b] - isum[c] + isum[d];
      const sq = isq[a] - isq[b] - isq[c] + isq[d];
      const m = sum / n;
      meanMap[y * dw + x] = m;
      sdMap[y * dw + x] = Math.sqrt(Math.max(0, sq / n - m * m));
    }
  }
  for (let y = 0; y < h; y++) {
    const my = Math.min(dh - 1, y >> 2) * dw;
    for (let x = 0; x < w; x++) {
      const mi = my + Math.min(dw - 1, x >> 2);
      const m = meanMap[mi];
      const t = m * (1 + 0.25 * (sdMap[mi] / 128 - 1));
      const lim = Math.min(Math.max(t, m * 0.72), m * 0.97);
      data[y * w + x] = data[y * w + x] < lim ? 0 : 255;
    }
  }
}

/** 投影法估斜角：正确角度下「行投影」的方差最大 */
export function estimateSkew(gray: GrayImage): number {
  const { width: w, height: h, data } = gray;
  const scale = Math.max(1, Math.ceil(w / 800));
  const sw = Math.max(1, Math.floor(w / scale)), sh = Math.max(1, Math.floor(h / scale));
  const t = otsu(gray);
  const bin = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      let sum = 0, n = 0;
      for (let dy = 0; dy < scale; dy++) {
        const yy = y * scale + dy;
        if (yy >= h) break;
        for (let dx = 0; dx < scale; dx++) {
          const xx = x * scale + dx;
          if (xx >= w) break;
          sum += data[yy * w + xx] < t ? 1 : 0; n++;
        }
      }
      bin[y * sw + x] = n && sum / n > 0.25 ? 1 : 0;
    }
  }
  const score = (deg: number): number => {
    const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    const cx = sw / 2, cy = sh / 2;
    const rows = new Float64Array(sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (!bin[y * sw + x]) continue;
        const dx = x - cx, dy = y - cy;
        const nx = Math.round(cx + dx * cos - dy * sin);
        const ny = Math.round(cy + dx * sin + dy * cos);
        if (nx >= 0 && nx < sw && ny >= 0 && ny < sh) rows[ny]++;
      }
    }
    let mean = 0;
    for (let i = 0; i < sh; i++) mean += rows[i];
    mean /= sh;
    let v = 0;
    for (let i = 0; i < sh; i++) v += (rows[i] - mean) ** 2;
    return v / sh;
  };
  let bestAngle = 0, bestScore = -1;
  for (let a = -5; a <= 5; a += 0.5) {
    const s = score(a);
    if (s > bestScore) { bestScore = s; bestAngle = a; }
  }
  for (let a = bestAngle - 0.4; a <= bestAngle + 0.4; a += 0.2) {
    const s = score(a);
    if (s > bestScore) { bestScore = s; bestAngle = a; }
  }
  return Math.abs(bestAngle) < 0.5 ? 0 : Math.round(bestAngle * 10) / 10;
}

function rotateGray(gray: GrayImage, deg: number, fill = 255): GrayImage {
  const { width: w, height: h, data } = gray;
  const out = new Uint8ClampedArray(w * h);
  const rad = -deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = cx + dx * cos - dy * sin;
      const sy = cy + dx * sin + dy * cos;
      if (sx < 0 || sy < 0 || sx >= w - 1 || sy >= h - 1) { out[y * w + x] = fill; continue; }
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i = y0 * w + x0;
      const v = data[i] * (1 - fx) * (1 - fy) + data[i + 1] * fx * (1 - fy)
        + data[i + w] * (1 - fx) * fy + data[i + w + 1] * fx * fy;
      out[y * w + x] = v;
    }
  }
  return { width: w, height: h, data: out };
}

/** 双线性放大：低分辨率图片先放大到 Tesseract 舒服的字高（约 30~40px） */
export function upscaleGray(src: GrayImage, factor: number): GrayImage {
  if (factor <= 1) return src;
  const w = Math.round(src.width * factor), h = Math.round(src.height * factor);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, y / factor);
    const y0 = sy | 0, y1 = Math.min(src.height - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, x / factor);
      const x0 = sx | 0, x1 = Math.min(src.width - 1, x0 + 1), fx = sx - x0;
      const dx = x1 - x0;
      const i = y0 * src.width + x0, j = y1 * src.width + x0;
      out[y * w + x] = (src.data[i] * (1 - fx) + src.data[i + dx] * fx) * (1 - fy)
        + (src.data[j] * (1 - fx) + src.data[j + dx] * fx) * fy;
    }
  }
  return { width: w, height: h, data: out };
}

/** 主入口：对灰度图做预处理，返回可直接交给 Tesseract 的灰度图 */
export function preprocessGray(
  source: GrayImage,
  mode: PreprocessMode,
  opts: { deskew?: boolean; largeArea?: number; upscale?: number } = {},
): PreprocessResult {
  // 与离线验收链路一致：小图先放大到 Tesseract 舒适的字高（约 30~40px）。
  // 调用方显式指定 upscale 时以其为准（例如身份证模块固定 2×）。
  const factor = opts.upscale ?? (
    source.width < AUTO_UPSCALE_WIDTH
      && source.width * source.height <= AUTO_UPSCALE_MAX_AREA ? 2 : 1
  );
  let base = factor > 1 ? upscaleGray(source, factor) : source;
  const rawStats = sampleStats(base);
  const inverted = rawStats.hi < 150;
  if (inverted) {
    base = { ...base, data: base.data.slice() };
    for (let i = 0; i < base.data.length; i++) base.data[i] = 255 - base.data[i];
  }
  const stats0 = inverted ? sampleStats(base) : rawStats;
  const angle = opts.deskew === false ? 0 : estimateSkew(base);
  let image = angle ? rotateGray(base, angle) : { ...base, data: base.data.slice() };
  const stats: ImageStats = { ...stats0, angle, inverted, upscale: factor };

  if (mode === 'none') return { image, applied: 'none', stats };

  const needBinary = mode === 'binary' || (mode === 'auto' && stats.uneven > 22);
  const needStretch = mode === 'gray' || (mode === 'auto' && (stats.contrast < 170 || stats.uneven > 22));
  const needDenoise = mode === 'gray' || (mode === 'auto' && stats.noise > 9);

  // 大图（>1200 万像素）跳过中值滤波，避免阻塞主线程过久
  const areaLimit = opts.largeArea ?? 12_000_000;
  if (needDenoise && image.width * image.height <= areaLimit) median3(image);
  if (needStretch && !needBinary) stretchContrast(image, stats.lo, stats.hi);
  if (needBinary) adaptiveBinarize(image);

  return {
    image,
    applied: needBinary ? 'binary' : (needStretch || needDenoise ? 'gray' : 'none'),
    stats,
  };
}

/** 浏览器入口：canvas → 预处理后的 canvas（未指定 upscale 时自动按小图放大） */
export function processCanvas(
  sourceCanvas: HTMLCanvasElement,
  mode: PreprocessMode,
  opts: { deskew?: boolean; upscale?: number } = {},
): { canvas: HTMLCanvasElement; result: PreprocessResult } {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const ctx = sourceCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法读取画布内容');
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const result = preprocessGray(rgbaToGray(rgba, w, h), mode, opts);
  const out = document.createElement('canvas');
  out.width = result.image.width; out.height = result.image.height;
  const octx = out.getContext('2d');
  if (!octx) throw new Error('无法创建输出画布');
  const image = octx.createImageData(out.width, out.height);
  image.data.set(grayToRgba(result.image));
  octx.putImageData(image, 0, 0);
  return { canvas: out, result };
}

/** 中文 OCR 常见的「字间插空格」等后处理 */
export function normalizeOcrText(raw: string): string {
  let s = raw.replace(/\u3000/g, ' ').replace(/\r/g, '');
  // 全角 ASCII 字母数字 → 半角（保留中文标点）
  s = s.replace(/[\uff10-\uff19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\uff21-\uff3a\uff41-\uff5a]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 中文语境里 Tesseract 常把「：」「，」输出成半角，跟在汉字后时应还原为全角
  const PUNCT: Record<string, string> = { ':': '：', ',': '，', ';': '；', '!': '！', '?': '？' };
  s = s.replace(/([\u3400-\u9fff\u3000-\u303f])\s*([:,;!?])/g, (_m, a, p) => a + PUNCT[p]);
  const isCjk = (c: string) => !!c && CJK_RE.test(c);
  // 反复去掉「CJK 字符 + 空格 + CJK 字符」中的空格
  let prev = '';
  for (let pass = 0; pass < 4 && prev !== s; pass++) {
    prev = s;
    s = s.replace(/([^\s])([ \t]+)([^\s])/g, (m, a, _sp, b) =>
      isCjk(a) && isCjk(b) ? a + b : m);
  }
  // 中文标点前不留空格（如「6% 。」→「6%。」）
  s = s.replace(/[ \t]+(?=[，。、；：！？）】》」』])/g, '');
  s = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
