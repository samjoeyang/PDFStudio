import { useLayoutEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { containLayout, moveCrop, resizeCrop } from '../lib/idcard';
import type { CropRect, IdCardSource } from '../lib/idcard';

interface Props {
  card: IdCardSource;
  onChange: (crop: CropRect) => void;
}

interface Layout { W: number; H: number; ox: number; oy: number; dw: number; dh: number }
interface DragState {
  mode: 'move' | 'resize' | 'none';
  sx: number;
  sy: number;
  crop: CropRect;
}

/**
 * 原图取景框编辑器：整张照片按 contain 显示，半透明遮罩外只留 1.5852 比例的高亮框。
 * 框的位置就是 PDF 里裁出来的区域，拖动框 / 拖右下角 / 点击框外即可修正，
 * 不需要再凭成品预览反推证件在哪里。
 */
export default function IdCardFrameEditor({ card, onChange }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [layout, setLayout] = useState<Layout>({ W: 0, H: 0, ox: 0, oy: 0, dw: 0, dh: 0 });

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const W = stage.clientWidth, H = stage.clientHeight;
      if (!W || !H) return;
      const L = containLayout(W, H, card.base.width, card.base.height);
      setLayout({ W, H, ox: L.ox, oy: L.oy, dw: L.dw, dh: L.dh });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#eef1f5';
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(card.base, L.ox, L.oy, L.dw, L.dh);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [card.base, card.rotation, card.angle]);

  const fx = layout.ox + card.crop.x * layout.dw;
  const fy = layout.oy + card.crop.y * layout.dh;
  const fw = card.crop.w * layout.dw;
  const fh = card.crop.h * layout.dh;

  const onStageDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!layout.dw || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const nx = (e.clientX - r.left - layout.ox) / layout.dw;
    const ny = (e.clientY - r.top - layout.oy) / layout.dh;
    const c = card.crop;
    const inside = nx >= c.x && nx <= c.x + c.w && ny >= c.y && ny <= c.y + c.h;
    stageRef.current.setPointerCapture(e.pointerId);
    if (!inside) {
      // 点击框外：把取景框中心直接移到点击处，便于一键重新定位
      const moved = moveCrop(c, nx - (c.x + c.w / 2), ny - (c.y + c.h / 2));
      onChange(moved);
      dragRef.current = { mode: 'none', sx: e.clientX, sy: e.clientY, crop: moved };
      return;
    }
    dragRef.current = { mode: 'move', sx: e.clientX, sy: e.clientY, crop: { ...c } };
  };

  const onHandleDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    if (!stageRef.current) return;
    stageRef.current.setPointerCapture(e.pointerId);
    dragRef.current = { mode: 'resize', sx: e.clientX, sy: e.clientY, crop: { ...card.crop } };
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.mode === 'none' || !layout.dw) return;
    const dx = (e.clientX - d.sx) / layout.dw;
    const dy = (e.clientY - d.sy) / layout.dh;
    if (d.mode === 'move') {
      onChange(moveCrop(d.crop, dx, dy));
    } else {
      onChange(resizeCrop(d.crop, d.crop.w + dx, card.base.width, card.base.height, 'start'));
    }
  };
  const onUp = () => { dragRef.current = null; };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!layout.dw) return;
    const factor = e.deltaY > 0 ? 1.08 : 0.92;
    onChange(resizeCrop(card.crop, card.crop.w * factor, card.base.width, card.base.height, 'center'));
  };

  return (
    <div className="idcard-frame-wrap">
      <div className="idcard-frame-stage" ref={stageRef}
        onPointerDown={onStageDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp} onWheel={onWheel}>
        <canvas ref={canvasRef} className="idcard-frame-photo" />
        {fw > 0 && (
          <div className="idcard-frame" style={{ left: fx, top: fy, width: fw, height: fh }}>
            <span className="idcard-frame-third v1" />
            <span className="idcard-frame-third v2" />
            <span className="idcard-frame-third h1" />
            <span className="idcard-frame-third h2" />
            <span className="idcard-frame-corner nw" />
            <span className="idcard-frame-corner ne" />
            <span className="idcard-frame-corner sw" />
            <span className="idcard-frame-handle se" title="拖动缩放取景框"
              onPointerDown={onHandleDown} />
          </div>
        )}
      </div>
      <div className="idcard-frame-tip">
        白框内即最终进入 PDF 的区域 · 拖动框可移动 · 拖右下角或滚轮可缩放 · 点击框外可重新居中
      </div>
      <div className="idcard-frame-tip muted">
        这里显示的是按当前旋转角度处理后的整张照片。若照片中证件本身缺失一半，自动定位与旋转都无法补出缺失内容，需要更换完整的照片。
      </div>
      <span className="idcard-frame-angle" title="正交方向 + 手写微调角度">
        {card.rotation}°{card.angle ? ` ${card.angle > 0 ? '+' : ''}${card.angle}°` : ''}
      </span>
    </div>
  );
}
