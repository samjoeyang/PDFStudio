export interface DocItem {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
}

export interface PageItem {
  id: string;
  docId: string;
  pageIndex: number;
  rotation: number;
}

/** mask = 不透明遮挡块；导出时会连同该页底层文字一起抹除 */
export type AnnotationType = 'highlight' | 'text' | 'ink' | 'signature' | 'mask';

export interface InkStroke {
  points: { x: number; y: number }[];
}

/** 坐标全部使用相对页面的 0~1 归一化值，y 从页面顶部算起 */
export interface Annotation {
  id: string;
  pageId: string;
  type: AnnotationType;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text?: string;
  image?: string;
  strokes?: InkStroke[];
}

export interface OcrWordBox {
  text: string;
  /** 归一化到页面宽高的 0~1 坐标，y 从页面顶部起算 */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface OcrResult {
  pageNumber: number;
  text: string;
  confidence: number;
  source: 'layer' | 'ocr';
  /** OCR 页附带的版面信息，用于生成按位置对齐的可搜索文本层 */
  columns?: number;
  preprocess?: 'none' | 'gray' | 'binary';
  angle?: number;
  upscale?: number;
  words?: OcrWordBox[];
}

export interface WorkspaceState {
  docs: DocItem[];
  pages: PageItem[];
  annotations: Annotation[];
}
