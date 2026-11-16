import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { renderPageImage, getPageNatural, MM_PER_PT } from '../lib/thumb';
import type { Annotation, AnnotationType, DocItem, InkStroke, PageItem } from '../lib/types';
import { useZoomPan } from '../lib/useZoomPan';
import ZoomControls from './ZoomControls';

const uid = () => Math.random().toString(36).slice(2, 10);
const COLORS = ['#eab308', '#ef4444', '#22c55e', '#3b82f6', '#8b5cf6'];
/** 遮挡用实色：黑 / 白 / 灰，跟高亮调色板分开，避免切工具后颜色串味 */
const MASK_COLORS = ['#111111', '#ffffff', '#94a3b8'];
const TOOL_LABEL: Record<AnnotationType, string> = {
  highlight: '高亮', text: '文字', ink: '画笔', signature: '签名/盖章', mask: '遮挡',
};

/** 公章尺寸固定约束在 40~45mm（真实物理尺寸），默认 42mm */
const SEAL_MM_MIN = 40;
const SEAL_MM_MAX = 45;
const SEAL_MM_DEFAULT = 42;

const annLabel = (a: Annotation): string => {
  if (a.type === 'signature') return a.stamp === 'seal' ? '公章' : '签名';
  return TOOL_LABEL[a.type];
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Box { x: number; y: number; w: number; h: number }

/** 由中心点 + 边长（归一化，相对页面宽）生成正方形框；按页面纵横比换算高度，确保视觉为正圆/正方 */
const sealBox = (cx: number, cy: number, sideW: number, aspect: number): Box => {
  const w = sideW;
  const h = sideW * aspect;
  const x = clamp(cx - w / 2, 0, Math.max(0, 1 - w));
  const y = clamp(cy - h / 2, 0, Math.max(0, 1 - h));
  return { x, y, w, h };
};

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SEAL_HANDLES: Handle[] = ['nw', 'ne', 'se', 'sw'];

const handleCursor: Record<Handle, string> = {
  nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize',
  se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize',
};

interface Props {
  page: PageItem;
  doc: DocItem;
  order: number;
  initial: Annotation[];
  onSave: (anns: Annotation[]) => void;
  onClose: () => void;
}

/** 通用框体（非公章）按手柄拖拽改变大小；保持最小尺寸并夹在页面内 */
const resizeBoxGeneric = (box: Box, handle: Handle, p: { x: number; y: number }, start: { x: number; y: number }): Box => {
  const dx = p.x - start.x;
  const dy = p.y - start.y;
  let { x, y, w, h } = box;
  if (handle.includes('w')) { x = box.x + dx; w = box.w - dx; }
  if (handle.includes('e')) { w = box.w + dx; }
  if (handle.includes('n')) { y = box.y + dy; h = box.h - dy; }
  if (handle.includes('s')) { h = box.h + dy; }
  if (w < 0) { x += w; w = -w; }
  if (h < 0) { y += h; h = -h; }
  const MIN = 0.02;
  if (w < MIN) { if (handle.includes('w')) x = box.x + box.w - MIN; w = MIN; }
  if (h < MIN) { if (handle.includes('n')) y = box.y + box.h - MIN; h = MIN; }
  x = clamp(x, 0, Math.max(0, 1 - w));
  y = clamp(y, 0, Math.max(0, 1 - h));
  return { x, y, w, h };
};

/** 公章框体：锁正方形并按手柄从对角锚点缩放，尺寸夹在 40~45mm 对应归一化区间 */
const resizeSeal = (
  box: Box, handle: Handle, p: { x: number; y: number },
  aspect: number, ratioMin: number, ratioMax: number,
): Box => {
  const hx = handle.includes('w') ? -1 : handle.includes('e') ? 1 : 0;
  const hy = handle.includes('n') ? -1 : handle.includes('s') ? 1 : 0;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const anchorX = hx !== 0 ? cx - (hx * box.w) / 2 : cx;
  const anchorY = hy !== 0 ? cy - (hy * box.h) / 2 : cy;
  let w = box.w;
  if (hx !== 0) w = 2 * Math.abs(p.x - anchorX);
  w = clamp(w, ratioMin, ratioMax);
  const h = w * aspect;
  const x = hx < 0 ? anchorX : hx > 0 ? anchorX - w : box.x;
  const y = hy < 0 ? anchorY : hy > 0 ? anchorY - h : box.y;
  return {
    x: clamp(x, 0, Math.max(0, 1 - w)),
    y: clamp(y, 0, Math.max(0, 1 - h)),
    w, h,
  };
};

export default function AnnotationEditor({ page, doc, order, initial, onSave, onClose }: Props) {
  const [anns, setAnns] = useState<Annotation[]>(initial);
  const [tool, setTool] = useState<AnnotationType>('highlight');
  const [color, setColor] = useState(COLORS[0]);
  const [img, setImg] = useState('');
  const [size, setSize] = useState({ w: 640, h: 840 });
  const [draft, setDraft] = useState<Box | null>(null);
  const [textDraft, setTextDraft] = useState<{ box: Box; value: string } | null>(null);
  const [signature, setSignature] = useState('');
  const [showSignPad, setShowSignPad] = useState(false);
  const [stampMode, setStampMode] = useState<'signature' | 'seal'>('signature');
  const [sealMM, setSealMM] = useState(SEAL_MM_DEFAULT);
  const [pendingUpload, setPendingUpload] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [aspect, setAspect] = useState(1); // 页面宽/高（真实比例，非渲染缩放）
  const [pageMM, setPageMM] = useState<{ w: number; h: number } | null>(null);
  const [panMode, setPanMode] = useState(false); // 抓手模式：开启后拖拽空白处平移视口
  const { vpRef, view, panning, fit, zoomIn, zoomOut, startPan } = useZoomPan(size);
  const stageRef = useRef<HTMLDivElement>(null);
  const signRef = useRef<HTMLCanvasElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const strokesRef = useRef<InkStroke[]>([]);
  const drawingRef = useRef(false);
  const signDrawingRef = useRef(false);
  const dragRef = useRef<{
    id: string; mode: 'move' | 'resize'; handle?: Handle;
    start: { x: number; y: number }; box: Box;
  } | null>(null);

  /** 真实页面尺寸（pt）→ 物理 mm，以及当前公章尺寸对应的归一化宽度区间 */
  const pageWidthMM = pageMM ? pageMM.w * MM_PER_PT : 210;
  const ratioMin = SEAL_MM_MIN / pageWidthMM;
  const ratioMax = SEAL_MM_MAX / pageWidthMM;
  const sealRatio = clamp(sealMM / pageWidthMM, ratioMin, ratioMax);

  useEffect(() => {
    let alive = true;
    void renderPageImage(doc.id, doc.bytes, page.pageIndex, page.rotation, 1100, 0.9)
      .then((url) => {
        if (!alive) return;
        setImg(url);
        const probe = new Image();
        probe.onload = () => {
          if (!alive) return;
          const ratio = probe.naturalHeight / probe.naturalWidth;
          const w = Math.min(700, Math.round(560 / ratio));
          setSize({ w, h: Math.round(w * ratio) });
        };
        probe.src = url;
      });
    void getPageNatural(doc.id, doc.bytes, page.pageIndex, page.rotation)
      .then(({ width, height }) => {
        if (!alive) return;
        setPageMM({ w: width, h: height });
        setAspect(width / height);
      });
    return () => { alive = false; };
  }, [doc, page.pageIndex, page.rotation]);

  // 换页 / 图片就绪后自动适应视口并居中一次（不覆盖用户后续的手动缩放）
  const fittedPage = useRef<string | null>(null);
  useEffect(() => {
    if (size.w && page.id !== fittedPage.current) {
      fittedPage.current = page.id;
      requestAnimationFrame(fit);
    }
  }, [size.w, size.h, page.id, fit]);

  useEffect(() => {
    if (!showSignPad) return;
    const ctx = signRef.current?.getContext('2d');
    if (ctx) {
      ctx.strokeStyle = '#1f2937';
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
  }, [showSignPad]);

  // 选中框体的移动 / 缩放：用 window 监听，避免指针离开元素后丢失事件
  useEffect(() => {
    const normFromEvent = (e: PointerEvent) => {
      const rect = stageRef.current!.getBoundingClientRect();
      return {
        x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
        y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
      };
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = normFromEvent(e);
      setAnns((prev) => prev.map((a) => {
        if (a.id !== d.id) return a;
        if (d.mode === 'move') {
          const x = clamp(d.box.x + (p.x - d.start.x), 0, Math.max(0, 1 - a.w));
          const y = clamp(d.box.y + (p.y - d.start.y), 0, Math.max(0, 1 - a.h));
          return { ...a, x, y };
        }
        if (a.type === 'signature' && a.stamp === 'seal') {
          return { ...a, ...resizeSeal(a, d.handle!, p, aspect, ratioMin, ratioMax) };
        }
        return { ...a, ...resizeBoxGeneric(a, d.handle!, p, d.start) };
      }));
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      // 同步公章尺寸滑块到当前实际 mm
      setAnns((prev) => {
        const a = prev.find((x) => x.id === d.id);
        if (a && a.type === 'signature' && a.stamp === 'seal') {
          setSealMM(clamp(Number((a.w * pageWidthMM).toFixed(1)), SEAL_MM_MIN, SEAL_MM_MAX));
        }
        return prev;
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [aspect, ratioMin, ratioMax, pageWidthMM]);

  const palette = tool === 'mask' ? MASK_COLORS : COLORS;
  const pickTool = (t: AnnotationType) => {
    setTool(t);
    const next = t === 'mask' ? MASK_COLORS : COLORS;
    if (!next.includes(color)) setColor(next[0]);
  };

  const norm = useCallback((e: ReactPointerEvent): { x: number; y: number } => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: clamp((e.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((e.clientY - rect.top) / rect.height, 0, 1),
    };
  }, []);

  const addAnn = (a: Annotation) => {
    setAnns((prev) => [...prev, a]);
    setSelectedId(a.id);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (textDraft || showSignPad) return;
    // 抓手模式或鼠标中键：拖拽平移视口而非绘制
    if (panMode || e.button === 1) { startPan(e); return; }
    // 在空白处开始绘制新批注：先取消现有选中
    setSelectedId(null);
    const p = norm(e);
    startRef.current = p;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'ink') {
      drawingRef.current = true;
      strokesRef.current = [...strokesRef.current, { points: [p] }];
    } else {
      setDraft({ x: p.x, y: p.y, w: 0, h: 0 });
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!startRef.current) return;
    const p = norm(e);
    if (tool === 'ink' && drawingRef.current) {
      const strokes = strokesRef.current;
      strokes[strokes.length - 1].points.push(p);
      setDraft((prev) => prev ?? { x: 0, y: 0, w: 0, h: 0 });
      return;
    }
    const s = startRef.current;
    // 公章：拖拽时即按页面真实尺寸显示为固定 40~45mm（默认 42mm），只跟随位置、不随拖拽变形
    if (tool === 'signature' && stampMode === 'seal') {
      const cx = (s.x + p.x) / 2;
      const cy = (s.y + p.y) / 2;
      setDraft(sealBox(cx, cy, sealRatio, aspect));
      return;
    }
    setDraft({
      x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y),
    });
  };

  const finish = (box: Box) => {
    const base = { id: uid(), pageId: page.id, color, ...box };
    if (tool === 'highlight') {
      addAnn({ ...base, type: 'highlight' });
    } else if (tool === 'text') {
      setTextDraft({ box, value: '' });
    } else if (tool === 'signature') {
      if (!signature) return;
      addAnn({ ...base, type: 'signature', image: signature, stamp: stampMode });
    } else if (tool === 'mask') {
      addAnn({ ...base, type: 'mask' });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = startRef.current;
    startRef.current = null;
    if (!start) return;
    if (tool === 'ink') {
      drawingRef.current = false;
      const strokes = strokesRef.current.filter((s) => s.points.length > 1);
      if (strokes.length) {
        addAnn({
          id: uid(), pageId: page.id, type: 'ink', color,
          x: 0, y: 0, w: 1, h: 1, strokes,
        });
      }
      strokesRef.current = [];
      setDraft(null);
      return;
    }
    const p = norm(e);
    const box = {
      x: Math.min(start.x, p.x), y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y),
    };
    // 公章：单击或拖拽都按固定 mm 尺寸放置（中心落在起止中点），不可自由变形
    if (tool === 'signature' && stampMode === 'seal') {
      const cx = (start.x + p.x) / 2;
      const cy = (start.y + p.y) / 2;
      setDraft(null);
      finish(sealBox(cx, cy, sealRatio, aspect));
      return;
    }
    setDraft(null);
    if (box.w > 0.005 && box.h > 0.005) finish(box);
    else if (tool === 'text') finish({ ...box, w: 0.3, h: 0.04 });
  };

  /** 选中某个批注并开始移动 / 缩放；阻止冒泡以免在空白处误建新批注 */
  const startDrag = (
    e: ReactPointerEvent, id: string, mode: 'move' | 'resize', handle?: Handle,
  ) => {
    if (textDraft || showSignPad) return;
    if (e.button !== 0) return; // 仅左键操作批注，中/右键让视口平移处理
    e.stopPropagation();
    const a = anns.find((x) => x.id === id);
    if (!a) return;
    setSelectedId(id);
    if (a.type === 'signature' && a.stamp === 'seal') {
      setSealMM(clamp(Number((a.w * pageWidthMM).toFixed(1)), SEAL_MM_MIN, SEAL_MM_MAX));
    }
    const p = norm(e);
    dragRef.current = { id, mode, handle, start: p, box: { x: a.x, y: a.y, w: a.w, h: a.h } };
  };

  const confirmText = () => {
    if (!textDraft || !textDraft.value.trim()) { setTextDraft(null); return; }
    addAnn({
      id: uid(), pageId: page.id, type: 'text', color,
      ...textDraft.box, text: textDraft.value.trim(),
    });
    setTextDraft(null);
  };

  const signPos = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onSignDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    signDrawingRef.current = true;
    const ctx = signRef.current!.getContext('2d')!;
    const p = signPos(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onSignMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!signDrawingRef.current) return;
    const ctx = signRef.current!.getContext('2d')!;
    const p = signPos(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };
  const onSignUp = () => { signDrawingRef.current = false; };

  const useSignature = () => {
    const data = signRef.current?.toDataURL('image/png');
    if (data) setSignature(data);
    setShowSignPad(false);
    setTool('signature');
    setStampMode('signature');
  };

  const chooseUpload = (stamp: 'signature' | 'seal') => {
    if (!pendingUpload) return;
    setSignature(pendingUpload);
    setStampMode(stamp);
    setTool('signature');
    setPendingUpload(null);
  };

  const clearSignPad = () => {
    const c = signRef.current;
    if (!c) return;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  };

  /** 调整公章尺寸：同步滑块值，并对已选中的公章实时缩放（保持中心不动） */
  const onSealMMChange = (v: number) => {
    setSealMM(v);
    if (!selectedId) return;
    setAnns((prev) => prev.map((a) => {
      if (a.id !== selectedId || !(a.type === 'signature' && a.stamp === 'seal')) return a;
      const w = clamp(v / pageWidthMM, ratioMin, ratioMax);
      const cx = a.x + a.w / 2;
      const cy = a.y + a.h / 2;
      return { ...a, ...sealBox(cx, cy, w, aspect) };
    }));
  };

  const uploadSignature = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPendingUpload(String(reader.result));
    reader.readAsDataURL(file);
  };

  const isSeal = (a: Annotation) => a.type === 'signature' && a.stamp === 'seal';
  const activeHandles = (a: Annotation): Handle[] => (isSeal(a) ? SEAL_HANDLES : HANDLES);

  return (
    <div className="modal-backdrop">
      <div className="modal modal-annot">
        <div className="modal-head">
          <div>
            <h3>批注与签章</h3>
            <span>第 {order + 1} 页 · {doc.name}</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="annot-toolbar">
          <div className="btn-row">
            {(['highlight', 'text', 'ink', 'signature', 'mask'] as AnnotationType[]).map((t) => (
              <button key={t} className={`btn btn-small${tool === t ? ' is-active' : ''}`}
                title={t === 'mask' ? '拖出不透明遮挡块；导出后底层文字会被真正抹除' : undefined}
                onClick={() => pickTool(t)}>{TOOL_LABEL[t]}</button>
            ))}
          </div>
          <div className="color-row">
            {palette.map((c) => (
              <button key={c} className={`color-dot${color === c ? ' is-active' : ''}`}
                style={{ background: c }} onClick={() => setColor(c)}
                aria-label={tool === 'mask' ? '遮挡颜色' : '颜色'} />
            ))}
            {tool === 'mask' && <span className="muted small">遮挡颜色</span>}
          </div>
          <div className="btn-row">
            <button className={`btn btn-small${panMode ? ' is-active' : ''}`}
              onClick={() => setPanMode((p) => !p)}
              title="开启后拖拽空白处可平移页面，放大后便于看清细节 / 精准定位">移动</button>
          </div>
          <div className="btn-row">
            <button className="btn btn-small" onClick={() => { setStampMode('signature'); setShowSignPad(true); }}>写签名</button>
            <label className="btn btn-small btn-file">
              上传签章
              <input type="file" accept="image/*" hidden
                onChange={(e) => { uploadSignature(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {signature && <span className="sig-ready">签章已就绪</span>}
          </div>
          {tool === 'signature' && (
            <div className="stamp-toggle">
              <span className="muted small">类型</span>
              <button className={`btn btn-small${stampMode === 'signature' ? ' is-active' : ''}`}
                onClick={() => setStampMode('signature')}>签名</button>
              <button className={`btn btn-small${stampMode === 'seal' ? ' is-active' : ''}`}
                onClick={() => setStampMode('seal')}>公章</button>
              {stampMode === 'seal' && (
                <span className="seal-size">
                  <span className="muted small">公章尺寸</span>
                  <input type="range" min={SEAL_MM_MIN} max={SEAL_MM_MAX} step={0.5} value={sealMM}
                    onChange={(e) => onSealMMChange(Number(e.target.value))} />
                  <span className="muted small">{sealMM} mm（固定 40~45）</span>
                </span>
              )}
            </div>
          )}
        </div>

        <div className="annot-body">
          <div className="annot-scroll" ref={vpRef}>
            <div
              ref={stageRef}
              className={`annot-stage${panMode ? ' is-pan' : ''}${panning ? ' is-panning' : ''}`}
              style={{
                width: size.w, height: size.h,
                transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.zoom})`,
                transformOrigin: '0 0',
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {img && <img src={img} alt="页面" draggable={false} />}
              {anns.map((a) => {
                if (a.type === 'ink') {
                  return (
                    <svg key={a.id} className="annot-ink" viewBox="0 0 1 1" preserveAspectRatio="none">
                      {(a.strokes ?? []).map((s, i) => (
                        <polyline key={i} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')}
                          fill="none" stroke={a.color} strokeWidth={0.004} strokeLinecap="round" />
                      ))}
                    </svg>
                  );
                }
                const selected = a.id === selectedId;
                return (
                  <div key={a.id}
                    className={`annot-item annot-${a.type}${selected ? ' is-selected' : ''}`}
                    style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%` }}
                    onPointerDown={(e) => startDrag(e, a.id, 'move')}>
                    {(a.type === 'highlight' || a.type === 'mask') && <span style={{ background: a.color }} />}
                    {a.type === 'text' && <span style={{ color: a.color }}>{a.text}</span>}
                    {a.type === 'signature' && a.image && <img src={a.image} alt="签名" />}
                    {selected && activeHandles(a).map((hd) => (
                      <span key={hd}
                        className={`resize-handle rh-${hd}`}
                        style={{ cursor: handleCursor[hd] }}
                        onPointerDown={(e) => startDrag(e, a.id, 'resize', hd)} />
                    ))}
                  </div>
                );
              })}
              {draft && (
                <div className={`annot-draft${tool === 'mask' ? ' is-mask' : ''}`}
                  style={{
                    left: `${draft.x * 100}%`, top: `${draft.y * 100}%`,
                    width: `${draft.w * 100}%`, height: `${draft.h * 100}%`,
                    borderColor: color,
                    background: tool === 'mask' ? color : undefined,
                  }} />
              )}
              {strokesRef.current.length > 0 && drawingRef.current && (
                <svg className="annot-ink" viewBox="0 0 1 1" preserveAspectRatio="none">
                  {strokesRef.current.map((s, i) => (
                    <polyline key={i} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')}
                      fill="none" stroke={color} strokeWidth={0.004} strokeLinecap="round" />
                  ))}
                </svg>
              )}
              {textDraft && (
                <div className="annot-text-input" style={{
                  left: `${textDraft.box.x * 100}%`, top: `${textDraft.box.y * 100}%`,
                }}>
                  <input autoFocus value={textDraft.value} placeholder="输入批注文字"
                    onChange={(e) => setTextDraft({ ...textDraft, value: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') confirmText(); if (e.key === 'Escape') setTextDraft(null); }} />
                  <button onClick={confirmText}>确定</button>
                </div>
              )}
            </div>
            <ZoomControls zoom={view.zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fit} />
          </div>

          <div className="annot-side">
            <div className="section-title">批注列表 ({anns.length})</div>
            <div className="annot-list">
              {anns.length === 0 && <p className="muted">在左侧页面上拖拽以添加</p>}
              {anns.map((a) => (
                <div className={`annot-row${a.id === selectedId ? ' is-selected' : ''}`} key={a.id}
                  onClick={() => setSelectedId(a.id)}>
                  <span className="badge">{annLabel(a)}</span>
                  <span className="annot-row-text">{a.text || (a.type === 'ink' ? '手绘笔迹' : a.type === 'signature' ? (a.stamp === 'seal' ? '公章图片' : '签名图片') : a.type === 'mask' ? '遮挡区域' : '高亮区域')}</span>
                  <button onClick={(e) => { e.stopPropagation(); setAnns((prev) => prev.filter((x) => x.id !== a.id)); if (selectedId === a.id) setSelectedId(null); }}>删除</button>
                </div>
              ))}
            </div>
            <p className="muted small">批注在导出时写回 PDF；带批注的页会转为高清图像，中文可正常显示。</p>
            <p className="muted small">选中页面上的框体可拖动移动、拖角缩放；公章锁定 40~45mm 正方形。</p>
            <p className="muted small">「遮挡」是不透明实色块；导出时该页底层文字会被一并抹除，复制 / 搜索都不会再出现被遮内容。</p>
          </div>
        </div>

        {pendingUpload && (
          <div className="signpad-wrap upload-pick">
            <div className="section-title">该签章用作？</div>
            <div className="btn-row">
              <button className="btn btn-small" onClick={() => chooseUpload('signature')}>签名</button>
              <button className="btn btn-small btn-primary" onClick={() => chooseUpload('seal')}>公章</button>
              <button className="btn btn-small" onClick={() => setPendingUpload(null)}>取消</button>
            </div>
            <span className="muted small">公章将强制为正方形（标准公章大小，可整体缩放），签名保持原图比例。</span>
          </div>
        )}

        {showSignPad && (
          <div className="signpad-wrap">
            <div className="section-title">手写签名（透明背景）</div>
            <canvas ref={signRef} width={360} height={130}
              onPointerDown={onSignDown} onPointerMove={onSignMove} onPointerUp={onSignUp}
              onPointerLeave={onSignUp} />
            <div className="btn-row">
              <button className="btn btn-small" onClick={clearSignPad}>清空</button>
              <button className="btn btn-small btn-primary" onClick={useSignature}>使用签名</button>
              <button className="btn btn-small" onClick={() => setShowSignPad(false)}>取消</button>
            </div>
          </div>
        )}

        <div className="modal-foot">
          <span className="muted small">双击页面卡片可再次打开此编辑器</span>
          <div className="btn-row">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={() => onSave(anns)}>保存批注</button>
          </div>
        </div>
      </div>
    </div>
  );
}
