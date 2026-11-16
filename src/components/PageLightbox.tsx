import { useCallback, useEffect, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { renderPageImage } from '../lib/thumb';
import type { DocItem, PageItem } from '../lib/types';
import { useZoomPan } from '../lib/useZoomPan';
import ZoomControls from './ZoomControls';

interface Props {
  page: PageItem;
  doc: DocItem;
  order: number;
  onClose: () => void;
  onOpenEditor?: (id: string) => void;
}

/**
 * 单页大图预览（灯箱）：高分辨率渲染，套用通用缩放/平移。
 * 纯查看场景，左键拖拽 / 中键拖拽均可平移，滚轮以光标为锚点缩放。
 */
export default function PageLightbox({ page, doc, order, onClose, onOpenEditor }: Props) {
  const [url, setUrl] = useState('');
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [panning, setPanning] = useState(false);
  const { vpRef, view, fit, zoomIn, zoomOut, startPan } = useZoomPan(size);

  useEffect(() => {
    let alive = true;
    setUrl('');
    setSize({ w: 1, h: 1 });
    renderPageImage(page.docId, doc.bytes, page.pageIndex, page.rotation, 1400, 0.92)
      .then((u) => {
        if (!alive) return;
        setUrl(u);
        const img = new Image();
        img.onload = () => {
          if (!alive) return;
          setSize({ w: img.naturalWidth, h: img.naturalHeight });
        };
        img.src = u;
      })
      .catch(() => { if (alive) setUrl(''); });
    return () => { alive = false; };
  }, [page.docId, page.pageIndex, page.rotation, doc]);

  // 图片就绪或视口尺寸变化后自动适应居中
  useEffect(() => {
    if (size.w > 1) fit();
  }, [size.w, size.h, fit]);

  // 窗口尺寸变化时重新适应
  useEffect(() => {
    const onResize = () => { if (size.w > 1) fit(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [size.w, fit]);

  // 视口尺寸（含首次布局）变化时重新适应，避免初始高度为 0 时 fit 落到最小缩放
  useEffect(() => {
    const el = vpRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (size.w > 1) fit(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.w, fit]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return; // 不拦截控件按钮
    if (e.button === 0 || e.button === 1) {
      setPanning(true);
      startPan(e);
    }
  };
  const onUp = useCallback(() => setPanning(false), []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="modal modal-lightbox">
        <div className="modal-head">
          <div>
            <h3>预览 · {doc.name}</h3>
            <span>
              原第 {page.pageIndex + 1} 页 · 共 {doc.pageCount} 页 · 滚轮缩放，放大后拖动平移
            </span>
          </div>
          <div className="modal-head-actions">
            {onOpenEditor && (
              <button className="btn btn-small" onClick={() => onOpenEditor(page.id)}>批注 / 签名</button>
            )}
            <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
          </div>
        </div>
        <div
          ref={vpRef}
          className={`lb-viewport${panning ? ' is-panning' : ''}`}
          onPointerDown={onDown}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {url ? (
            <img
              className="lb-img"
              src={url}
              alt={`第 ${order + 1} 页`}
              draggable={false}
              style={{
                width: size.w,
                height: size.h,
                transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
              }}
            />
          ) : (
            <span className="page-loading">渲染中…</span>
          )}
          <ZoomControls zoom={view.zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fit} />
        </div>
      </div>
    </div>
  );
}
