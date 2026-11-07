import { PDFDocument, degrees } from 'pdf-lib';
import type { DocItem, PageItem } from './types';

export async function getPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  return doc.getPageCount();
}

/**
 * 按工作区里的页面顺序生成一份新 PDF。
 * 合并 / 拆分 / 重排 / 删除 / 旋转 全部收敛到这一个函数。
 */
export async function buildPdf(
  pages: PageItem[],
  docs: DocItem[],
  optimize: boolean,
): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const docMap = new Map(docs.map((d) => [d.id, d]));
  const cache = new Map<string, PDFDocument>();

  for (const p of pages) {
    const source = docMap.get(p.docId);
    if (!source) continue;
    let src = cache.get(p.docId);
    if (!src) {
      src = await PDFDocument.load(source.bytes, { ignoreEncryption: true });
      cache.set(p.docId, src);
    }
    const [copied] = await out.copyPages(src, [p.pageIndex]);
    const base = copied.getRotation().angle;
    copied.setRotation(degrees(((base + p.rotation) % 360 + 360) % 360));
    out.addPage(copied);
  }

  if (optimize) {
    out.setTitle('');
    out.setAuthor('');
    out.setSubject('');
    out.setKeywords([]);
    out.setProducer('PDF Studio');
    out.setCreator('PDF Studio');
  }

  return out.save({ useObjectStreams: optimize });
}
