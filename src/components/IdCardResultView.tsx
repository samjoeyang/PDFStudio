import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  CARD_PX_W, CARD_PX_H, panCrop, renderCardCanvas,
} from '../lib/idcard';
import type { CropRect, IdCardSource } from '../lib/idcard';
import { useZoomPan } from '../lib/useZoomPan';
import ZoomControls from './ZoomControls';

interface Props {
  card: IdCardSource;
  onCrop: (crop: CropRect) => void;
}

/**
 * 身份证「成品预览」：渲染最终进 PDF 的裁剪结果。
 * - 滚轮 / +− 缩放（以光标为锚点），放大后可用「移动」按钮或鼠标中键拖拽平移查看。
 * - 关闭「移动」时，左键拖拽 = 平移取景（调整进入 PDF 的证件区域），与「原图框选」互补。
 */
export default function IdCardResultView({ card, onCrop }: Props) {
  const { vpRef, view, panning, fit, zoomIn, zoomOut, startPan } = useZoomPan({
    w: CARD_PX_W,
    h: CARD_PX_H,
  });
  const [panMode, setPanMode] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; cropX: number; cropY: number } | null>(null);
  const panModeRef = useRef(panMode);
  panModeRef.current = panMode;

  // 重绘裁剪结果
  useEffect(() => {
    const target = canvasRef.current;
    if (!target) return;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, CARD_PX_W, CARD_PX_H);
    ctx.drawImage(renderCardCanvas(card), 0, 0);
  }, [card]);

  // 首次挂载自动适应窗口
  const didFit = useRef(false);
  useEffect(() => {
    if (didFit.current) return;
    didFit.current = true;
    fit();
  }, [fit]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // 中键 或「移动」模式：平移视口查看
    if (e.button === 1 || panModeRef.current) {
      startPan(e);
      return;
    }
    // 默认左键：平移取景（调整进入 PDF 的证件区域）
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, cropX: card.crop.x, cropY: card.crop.y };
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    // 屏幕位移按比例换算到源图像归一化坐标；放大后灵敏度随 zoom 同步降低
    const dx = (e.clientX - d.x) / (CARD_PX_W * view.zoom);
    const dy = (e.clientY - d.y) / (CARD_PX_H * view.zoom);
    onCrop(panCrop({ ...card.crop, x: d.cropX, y: d.cropY }, dx, dy));
  };

  const onUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      className={`idcard-viewport${panMode ? ' pan-on' : ''}${panning ? ' panning' : ''}`}
      ref={vpRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
      <div
        className="idcard-stage"
        style={{
          width: CARD_PX_W,
          height: CARD_PX_H,
          transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
        }}
      >
        <canvas ref={canvasRef} width={CARD_PX_W} height={CARD_PX_H} className="idcard-canvas" />
      </div>
      <span className="idcard-ratio">85.6 × 54 mm</span>
      <button
        type="button"
        className={`idcard-pan-toggle${panMode ? ' is-on' : ''}`}
        onClick={() => setPanMode((v) => !v)}
        title="开启后可拖动平移视图（放大后看细节）；关闭时拖动为平移取景"
      >移动</button>
      <ZoomControls zoom={view.zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fit} />
    </div>
  );
}
