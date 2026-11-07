import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

// pdfjs v4 在较旧的 WebKit 上需要 Promise.withResolvers
const promiseCtor = Promise as unknown as { withResolvers?: unknown };
if (typeof promiseCtor.withResolvers === 'undefined') {
  promiseCtor.withResolvers = function () {
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

const docCache = new Map<string, Promise<PDFDocumentProxy>>();
const thumbCache = new Map<string, string>();

function getDocument(id: string, bytes: Uint8Array): Promise<PDFDocumentProxy> {
  let pending = docCache.get(id);
  if (!pending) {
    // pdfjs 会转移传入的 buffer，必须给副本，否则原始字节会被清空
    pending = pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
    docCache.set(id, pending);
  }
  return pending;
}

/** 打开一份临时 PDF（导出结果 / OCR 输入），用完记得 destroy() */
export async function loadPdfJsDoc(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
}

export async function renderPageToCanvas(
  pdf: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 canvas 上下文');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

export function clearThumbCache(docId?: string) {
  if (!docId) {
    thumbCache.clear();
    docCache.clear();
    return;
  }
  for (const key of thumbCache.keys()) {
    if (key.startsWith(`${docId}:`)) thumbCache.delete(key);
  }
  docCache.delete(docId);
}

export async function renderPageImage(
  docId: string,
  bytes: Uint8Array,
  pageIndex: number,
  rotation: number,
  maxSize: number,
  quality = 0.85,
): Promise<string> {
  const key = `${docId}:${pageIndex}:${rotation}:${maxSize}`;
  const cached = thumbCache.get(key);
  if (cached) return cached;

  const pdf = await getDocument(docId, bytes);
  const page = await pdf.getPage(pageIndex + 1);
  const natural = page.getViewport({ scale: 1 });
  const scale = maxSize / Math.max(natural.width, natural.height);
  const viewport = page.getViewport({
    scale,
    rotation: (page.rotate + rotation + 360) % 360,
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  const url = canvas.toDataURL('image/jpeg', quality);
  thumbCache.set(key, url);
  return url;
}

export const renderThumb = (
  docId: string,
  bytes: Uint8Array,
  pageIndex: number,
  rotation: number,
) => renderPageImage(docId, bytes, pageIndex, rotation, 190, 0.75);
