import { useEffect, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import { renderThumb } from '../lib/thumb';
import type { DocItem, PageItem } from '../lib/types';

interface Props {
  page: PageItem;
  doc: DocItem;
  order: number;
  selected: boolean;
  annotationCount: number;
  onSelect: (id: string, e: MouseEvent) => void;
  onDragStart: (e: DragEvent, id: string) => void;
  onDrop: (e: DragEvent, id: string) => void;
  onOpenEditor: (id: string) => void;
}

export default function PageCard({
  page, doc, order, selected, annotationCount,
  onSelect, onDragStart, onDrop, onOpenEditor,
}: Props) {
  const [thumb, setThumb] = useState('');

  useEffect(() => {
    let alive = true;
    setThumb('');
    renderThumb(page.docId, doc.bytes, page.pageIndex, page.rotation)
      .then((url) => { if (alive) setThumb(url); })
      .catch(() => { if (alive) setThumb(''); });
    return () => { alive = false; };
  }, [page.docId, page.pageIndex, page.rotation, doc]);

  return (
    <div
      className={`page-card${selected ? ' is-selected' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, page.id)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => onDrop(e, page.id)}
      onClick={(e) => onSelect(page.id, e)}
      onDoubleClick={() => onOpenEditor(page.id)}
      title={`${doc.name} · 原第 ${page.pageIndex + 1} 页 · 双击添加批注`}
    >
      <span className="page-order">{order + 1}</span>
      {annotationCount > 0 && <span className="page-annot-count">{annotationCount} 条批注</span>}
      <div className="page-preview">
        {thumb
          ? <img src={thumb} alt={`第 ${order + 1} 页`} draggable={false} />
          : <span className="page-loading">渲染中…</span>}
      </div>
      <div className="page-meta">
        <span className="page-name">{doc.name}</span>
        <span className="page-badges">
          {page.rotation !== 0 && <span className="badge">↻ {page.rotation}°</span>}
          <span className="badge">P{page.pageIndex + 1}</span>
        </span>
      </div>
    </div>
  );
}
