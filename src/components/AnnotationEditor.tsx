import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { renderPageImage } from '../lib/thumb';
import type { Annotation, AnnotationType, DocItem, InkStroke, PageItem } from '../lib/types';

const uid = () => Math.random().toString(36).slice(2, 10);
const COLORS = ['#eab308', '#ef4444', '#22c55e', '#3b82f6', '#8b5cf6'];
/** 遮挡用实色：黑 / 白 / 灰，跟高亮调色板分开，避免切工具后颜色串味 */
const MASK_COLORS = ['#111111', '#ffffff', '#94a3b8'];
const TOOL_LABEL: Record<AnnotationType, string> = {
  highlight: '高亮', text: '文字', ink: '画笔', signature: '签名', mask: '遮挡',
};

interface Box { x: number; y: number; w: number; h: number }

interface Props {
  page: PageItem;
  doc: DocItem;
  order: number;
  initial: Annotation[];
  onSave: (anns: Annotation[]) => void;
  onClose: () => void;
}

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
  const stageRef = useRef<HTMLDivElement>(null);
  const signRef = useRef<HTMLCanvasElement>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const strokesRef = useRef<InkStroke[]>([]);
  const drawingRef = useRef(false);
  const signDrawingRef = useRef(false);

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
    return () => { alive = false; };
  }, [doc, page.pageIndex, page.rotation]);

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

  const palette = tool === 'mask' ? MASK_COLORS : COLORS;
  const pickTool = (t: AnnotationType) => {
    setTool(t);
    const next = t === 'mask' ? MASK_COLORS : COLORS;
    if (!next.includes(color)) setColor(next[0]);
  };

  const norm = useCallback((e: ReactPointerEvent): { x: number; y: number } => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (textDraft || showSignPad) return;
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
    setDraft({
      x: Math.min(s.x, p.x), y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y),
    });
  };

  const finish = (box: Box) => {
    const base = { id: uid(), pageId: page.id, color, ...box };
    if (tool === 'highlight') {
      setAnns((prev) => [...prev, { ...base, type: 'highlight' }]);
    } else if (tool === 'text') {
      setTextDraft({ box, value: '' });
    } else if (tool === 'signature') {
      if (!signature) return;
      setAnns((prev) => [...prev, { ...base, type: 'signature', image: signature }]);
    } else if (tool === 'mask') {
      setAnns((prev) => [...prev, { ...base, type: 'mask' }]);
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
        setAnns((prev) => [...prev, {
          id: uid(), pageId: page.id, type: 'ink', color,
          x: 0, y: 0, w: 1, h: 1, strokes,
        }]);
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
    setDraft(null);
    if (box.w > 0.005 && box.h > 0.005) finish(box);
    else if (tool === 'text') finish({ ...box, w: 0.3, h: 0.04 });
  };

  const confirmText = () => {
    if (!textDraft || !textDraft.value.trim()) { setTextDraft(null); return; }
    setAnns((prev) => [...prev, {
      id: uid(), pageId: page.id, type: 'text', color,
      ...textDraft.box, text: textDraft.value.trim(),
    }]);
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
  };

  const clearSignPad = () => {
    const c = signRef.current;
    if (!c) return;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  };

  const uploadSignature = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setSignature(String(reader.result)); setTool('signature'); };
    reader.readAsDataURL(file);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal modal-annot">
        <div className="modal-head">
          <div>
            <h3>批注与签名</h3>
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
            <button className="btn btn-small" onClick={() => setShowSignPad(true)}>写签名</button>
            <label className="btn btn-small btn-file">
              上传签名
              <input type="file" accept="image/*" hidden
                onChange={(e) => { uploadSignature(e.target.files?.[0]); e.target.value = ''; }} />
            </label>
            {signature && <span className="sig-ready">签名已就绪</span>}
          </div>
        </div>

        <div className="annot-body">
          <div className="annot-scroll">
            <div
              ref={stageRef}
              className="annot-stage"
              style={{ width: size.w, height: size.h }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {img && <img src={img} alt="页面" draggable={false} />}
              {anns.map((a) => (
                a.type === 'ink' ? (
                  <svg key={a.id} className="annot-ink" viewBox="0 0 1 1" preserveAspectRatio="none">
                    {(a.strokes ?? []).map((s, i) => (
                      <polyline key={i} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')}
                        fill="none" stroke={a.color} strokeWidth={0.004} strokeLinecap="round" />
                    ))}
                  </svg>
                ) : (
                  <div key={a.id}
                    className={`annot-item annot-${a.type}`}
                    style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%`, width: `${a.w * 100}%`, height: `${a.h * 100}%` }}>
                    {(a.type === 'highlight' || a.type === 'mask') && <span style={{ background: a.color }} />}
                    {a.type === 'text' && <span style={{ color: a.color }}>{a.text}</span>}
                    {a.type === 'signature' && a.image && <img src={a.image} alt="签名" />}
                  </div>
                )
              ))}
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
          </div>

          <div className="annot-side">
            <div className="section-title">批注列表 ({anns.length})</div>
            <div className="annot-list">
              {anns.length === 0 && <p className="muted">在左侧页面上拖拽以添加</p>}
              {anns.map((a) => (
                <div className="annot-row" key={a.id}>
                  <span className="badge">{TOOL_LABEL[a.type]}</span>
                  <span className="annot-row-text">{a.text || (a.type === 'ink' ? '手绘笔迹' : a.type === 'signature' ? '签名图片' : a.type === 'mask' ? '遮挡区域' : '高亮区域')}</span>
                  <button onClick={() => setAnns((prev) => prev.filter((x) => x.id !== a.id))}>删除</button>
                </div>
              ))}
            </div>
            <p className="muted small">批注在导出时写回 PDF；带批注的页会转为高清图像，中文可正常显示。</p>
            <p className="muted small">「遮挡」是不透明实色块；导出时该页底层文字会被一并抹除，复制 / 搜索都不会再出现被遮内容。</p>
          </div>
        </div>

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
