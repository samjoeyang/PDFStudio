/**
 * 版面感知重排。
 *
 * Tesseract 在 PSM 6/4 下会把同一水平带的多个栏拼成「一行」输出，
 * 导致双栏文档的文字左右交错、完全不可读。这里用引擎返回的词级 bbox
 * 先切分栏带、再按行聚类，还原成「先左栏自上而下、再右栏自上而下」。
 */
export interface Box { x0: number; y0: number; x1: number; y1: number }
export interface LayoutWord { text: string; bbox: Box; confidence?: number }

interface Line {
  y: number;
  words: LayoutWord[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/** 用 x 方向的「贯穿空白」切出栏带；单栏页面会原样返回一个带 */
export function detectColumnBands(words: LayoutWord[], pageWidth: number): Array<[number, number]> {
  if (!words.length || pageWidth <= 0) return [[0, pageWidth]];
  const buckets = Math.max(40, Math.min(600, Math.ceil(pageWidth / 8)));
  const bw = pageWidth / buckets;
  const occupied = new Uint8Array(buckets);
  for (const w of words) {
    const a = Math.max(0, Math.min(buckets - 1, Math.floor(w.bbox.x0 / bw)));
    const b = Math.max(a, Math.min(buckets - 1, Math.ceil(w.bbox.x1 / bw) - 1));
    for (let i = a; i <= b; i++) occupied[i] = 1;
  }
  const minGap = Math.max(3, Math.ceil(pageWidth * 0.035 / bw));
  const bands: Array<[number, number]> = [];
  let start = 0;
  const gaps: Array<[number, number]> = [];
  let run = -1;
  for (let i = 0; i <= buckets; i++) {
    const empty = i === buckets || !occupied[i];
    if (empty) {
      if (run < 0) run = i;
    } else if (run >= 0) {
      if (i - run >= minGap) gaps.push([run, i]);
      run = -1;
    }
  }
  for (const [a, b] of gaps) {
    const x0 = a * bw, x1 = b * bw;
    if (x0 - start > pageWidth * 0.12) bands.push([start, x0]);
    start = x1;
  }
  if (pageWidth - start > pageWidth * 0.06) bands.push([start, pageWidth]);
  if (!bands.length) return [[0, pageWidth]];
  // 单栏页面常见的行首/行尾缩进也可能产生假缝，要求每栏都含足够多的词
  const counts = bands.map(([a, b]) => words.filter(w => (w.bbox.x0 + w.bbox.x1) / 2 >= a && (w.bbox.x0 + w.bbox.x1) / 2 < b).length);
  if (bands.length < 2 || counts.some(n => n < 4)) return [[0, pageWidth]];
  return bands;
}

function groupLines(words: LayoutWord[]): Line[] {
  const heights = words.map(w => w.bbox.y1 - w.bbox.y0).filter(h => h > 2);
  const h = median(heights) || 20;
  const tol = Math.max(6, h * 0.62);
  const sorted = [...words].sort((a, b) =>
    (a.bbox.y0 + a.bbox.y1) - (b.bbox.y0 + b.bbox.y1));
  const lines: Line[] = [];
  for (const w of sorted) {
    const cy = (w.bbox.y0 + w.bbox.y1) / 2;
    let line = lines.find(l => Math.abs(l.y - cy) <= tol);
    if (!line) { line = { y: cy, words: [] }; lines.push(line); }
    line.words.push(w);
    line.y = line.words.reduce((n, x) => n + (x.bbox.y0 + x.bbox.y1) / 2, 0) / line.words.length;
  }
  return lines.sort((a, b) => a.y - b.y);
}

export interface LayoutResult {
  text: string;
  columns: number;
  words: LayoutWord[];
}

/** 从词列表重建阅读顺序；单栏时结果与引擎原文基本一致 */
export function layoutText(
  words: LayoutWord[],
  pageWidth: number,
  opts: { minConfidence?: number } = {},
): LayoutResult {
  const usable = words.filter(w => w.text && w.text.trim()
    && (opts.minConfidence == null || (w.confidence ?? 100) >= opts.minConfidence));
  if (!usable.length) return { text: '', columns: 1, words: [] };
  const bands = detectColumnBands(usable, pageWidth);
  const out: string[] = [];
  const ordered: LayoutWord[] = [];
  for (const [a, b] of bands) {
    const inBand = usable.filter(w => {
      const cx = (w.bbox.x0 + w.bbox.x1) / 2;
      return cx >= a && cx < b;
    });
    for (const line of groupLines(inBand)) {
      const row = line.words.sort((x, y) => x.bbox.x0 - y.bbox.x0);
      ordered.push(...row);
      out.push(row.map(w => w.text).join(' '));
    }
  }
  return { text: out.join('\n'), columns: bands.length, words: ordered };
}
