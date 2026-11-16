import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { fitCenter, zoomAtPoint, type Pan } from './zoompan';

export interface View {
  zoom: number;
  pan: Pan;
}

/**
 * 缩放 + 平移的通用状态与交互。
 * - 内容（stage/canvas）通过 transform: translate(pan) scale(zoom) 呈现。
 * - 滚轮以光标为锚点缩放；左键/中键拖拽平移视口。
 * - 把 ref 绑到「视口」容器（overflow hidden），contentSize 传内容原始像素尺寸。
 */
export function useZoomPan(contentSize: { w: number; h: number }, enabled = true) {
  const vpRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [panning, setPanning] = useState(false);
  const panDrag = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const fit = useCallback(() => {
    const vp = vpRef.current;
    if (!vp || !contentSize.w || !contentSize.h) return;
    setView(fitCenter(contentSize.w, contentSize.h, vp.clientWidth, vp.clientHeight));
  }, [contentSize.w, contentSize.h]);

  const zoomBy = useCallback((factor: number, anchor?: { x: number; y: number }) => {
    const vp = vpRef.current;
    if (!vp) return;
    const a = anchor ?? { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
    setView((v) => zoomAtPoint(v.zoom, v.pan, factor, a.x, a.y));
  }, []);

  const zoomIn = useCallback(() => zoomBy(1.2), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.2), [zoomBy]);

  // 滚轮缩放：以光标在 viewport 内的位置为锚点，保持光标下内容点不动
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!enabledRef.current) return; // 仅「视图平移」模式接管滚轮
      e.preventDefault();
      e.stopPropagation(); // 阻止同元素的裁剪缩放等 onWheel 处理
      const rect = vp.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((v) => zoomAtPoint(v.zoom, v.pan, factor, e.clientX - rect.left, e.clientY - rect.top));
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, []);

  const startPan = useCallback((e: ReactPointerEvent) => {
    if (!enabledRef.current) return; // 仅「视图平移」模式接管拖拽
    e.preventDefault();
    panDrag.current = { sx: e.clientX, sy: e.clientY, px: view.pan.x, py: view.pan.y };
    setPanning(true);
    const move = (ev: PointerEvent) => {
      const d = panDrag.current;
      if (!d) return;
      setView((v) => ({ zoom: v.zoom, pan: { x: d.px + (ev.clientX - d.sx), y: d.py + (ev.clientY - d.sy) } }));
    };
    const up = () => {
      panDrag.current = null;
      setPanning(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [view.pan.x, view.pan.y]);

  return { vpRef, view, setView, panning, fit, zoomIn, zoomOut, startPan };
}
