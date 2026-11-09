import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, PointerEvent as ReactPointerEvent } from 'react';
import {
  autoGeometry, buildIdCardPdf, CARD_PX_H, CARD_PX_W, DEFAULT_OPTIONS,
  detectSideByOcr, extractIdNumber, geometryAt, guessSideFromName, layoutPlacements,
  loadImageFile, minimalCrop, panCrop, renderCardCanvas, resultHalfEmpty,
  SIDE_LABEL, sortCards, clampAngle, orthoSteps, withAngle, zoomCrop,
} from '../lib/idcard';
import type { CardSide, IdCardOptions, IdCardSource, Rotation } from '../lib/idcard';
import IdCardFrameEditor from './IdCardFrameEditor';
import { savePdf } from '../lib/platform';

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fmtAngle = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

interface Props {
  onClose: () => void;
  notify: (text: string, kind?: 'ok' | 'err') => void;
  onAddToWorkspace: (name: string, bytes: Uint8Array) => Promise<void>;
}

interface DragState {
  id: string;
  x: number;
  y: number;
  cropX: number;
  cropY: number;
  w: number;
  h: number;
}

/** 预览直接绘制 renderCardCanvas 的结果，与 PDF 用的是同一份裁剪几何 */
function CardPreview({ card }: { card: IdCardSource }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(renderCardCanvas(card), 0, 0);
  }, [card]);
  return <canvas ref={ref} width={CARD_PX_W} height={CARD_PX_H} className="idcard-canvas" />;
}

export default function IdCardPanel({ onClose, notify, onAddToWorkspace }: Props) {
  const [cards, setCards] = useState<IdCardSource[]>([]);
  const [opts, setOpts] = useState<IdCardOptions>(DEFAULT_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [viewMode, setViewMode] = useState<Record<string, 'result' | 'frame'>>({});
  const [angleDraft, setAngleDraft] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const cardsRef = useRef<IdCardSource[]>([]);

  useEffect(() => { cardsRef.current = cards; }, [cards]);
  useEffect(() => () => {
    cardsRef.current.forEach((c) => URL.revokeObjectURL(c.url));
  }, []);

  const updateCard = useCallback((id: string, patch: Partial<IdCardSource>) => {
    setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (!imgs.length) { notify('请选择 JPG / PNG / WebP 等图片', 'err'); return; }
    setBusy(true);
    try {
      const added: IdCardSource[] = [];
      for (let i = 0; i < imgs.length; i++) {
        const f = imgs[i];
        setStatus(`正在读取并自动定位证件 ${i + 1}/${imgs.length}…`);
        await new Promise<void>((r) => setTimeout(r, 0)); // 让状态先渲染出来
        const { image, url } = await loadImageFile(f);
        const geo = autoGeometry(image);
        const guessed = guessSideFromName(f.name);
        const card: IdCardSource = {
          id: uid(), name: f.name, url, image,
          side: guessed,
          detectedBy: guessed === 'unknown' ? undefined : 'name',
          ...geo,
        };
        const half = resultHalfEmpty(renderCardCanvas(card));
        if (half !== 'none') {
          card.locate = {
            ok: false,
            quality: geo.locate.quality,
            reason: half === 'bottom'
              ? '画面下半几乎空白，疑似照片不完整，请在「原图框选」确认'
              : '画面右半几乎空白，疑似照片不完整，请在「原图框选」确认',
          };
        }
        added.push(card);
      }
      setCards((prev) => [...prev, ...added]);
      // 定位置信度低的直接切到「原图框选」，让用户第一眼就看到框选了哪里
      setViewMode((prev) => {
        const next = { ...prev };
        added.forEach((c) => { next[c.id] = c.locate?.ok ? 'result' : 'frame'; });
        return next;
      });
      const failed = added.filter((c) => !c.locate?.ok).length;
      notify(failed
        ? `已加入 ${added.length} 张，其中 ${failed} 张定位存疑，已切到「原图框选」请确认`
        : `已加入 ${added.length} 张并自动定位证件区域`, failed ? 'err' : 'ok');
    } catch (e) { notify(`读取失败：${errText(e)}`, 'err'); }
    finally { setBusy(false); setStatus(''); }
  }, [notify]);

  const removeCard = useCallback((id: string) => {
    setCards((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((c) => c.id !== id);
    });
  }, []);

  const clearAll = useCallback(() => {
    cardsRef.current.forEach((c) => URL.revokeObjectURL(c.url));
    setCards([]);
  }, []);

  const relocate = useCallback((id: string) => {
    const c = cardsRef.current.find((v) => v.id === id);
    if (!c) return;
    const geo = autoGeometry(c.image, c.angle);
    updateCard(id, geo);
    setViewMode((prev) => ({ ...prev, [id]: geo.locate.ok ? 'result' : 'frame' }));
    notify(geo.locate.ok ? '已重新定位证件区域' : geo.locate.reason, geo.locate.ok ? 'ok' : 'err');
  }, [notify, updateCard]);

  /** 整步 ±90°：改正交方向并重新定位，用户手写的微调角度保持不变 */
  const rotate = useCallback((id: string, delta: 90 | -90) => {
    const c = cardsRef.current.find((v) => v.id === id);
    if (!c) return;
    const rotation = (((c.rotation + delta) % 360 + 360) % 360) as Rotation;
    updateCard(id, geometryAt(c.image, rotation, c.angle));
  }, [updateCard]);

  /** 手写任意角度：正顺时针、负逆时针，只重绘画布不重跑检测 */
  const setAngle = useCallback((id: string, angle: number) => {
    const c = cardsRef.current.find((v) => v.id === id);
    if (!c) return;
    updateCard(id, withAngle(c, angle));
  }, [updateCard]);

  const clearDraft = useCallback((id: string) => {
    setAngleDraft((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const applyAngle = useCallback((id: string) => {
    const text = angleDraft[id];
    if (text === undefined) return;
    const raw = text.trim();
    const value = Number(raw);
    if (raw !== '' && Number.isFinite(value)) {
      const a = clampAngle(value);
      const steps = orthoSteps(a);
      if (steps !== 0) {
        const c = cardsRef.current.find((v) => v.id === id);
        if (c) {
          const rotation = (((c.rotation + steps * 90) % 360 + 360) % 360) as Rotation;
          updateCard(id, geometryAt(c.image, rotation, c.angle));
          notify(`已整步${a > 0 ? '顺时针' : '逆时针'}旋转 ${Math.abs(a)}° 并重新定位`);
        }
      } else {
        setAngle(id, a);
      }
    }
    clearDraft(id);
  }, [angleDraft, clearDraft, notify, setAngle, updateCard]);

  const detectAll = useCallback(async () => {
    if (!cards.length || busy) return;
    setBusy(true);
    let flipped = 0;
    let idFound = 0;
    try {
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        setStatus(`正在离线识别 ${i + 1}/${cards.length}…`);
        const g = await detectSideByOcr(c);
        const side = g.side === 'unknown' ? c.side : g.side;
        const patch: Partial<IdCardSource> = {
          side,
          detectedBy: 'ocr',
          ocrText: g.text.slice(0, 300),
          idNumber: undefined,
          idNumberValid: undefined,
        };
        if (g.upsideDown) {
          // OCR 发现倒置：整图转 180° 后重新定位，裁剪框随之重建
          patch.rotation = ((c.rotation + 180) % 360) as Rotation;
          Object.assign(patch, geometryAt(c.image, patch.rotation, c.angle));
          flipped++;
        }
        // 人像面追加字段级号码提取（白名单 + 校验码），失败不影响判面
        if (side === 'front') {
          try {
            setStatus(`正在提取证件号 ${i + 1}/${cards.length}…`);
            const target = { ...c, ...patch } as IdCardSource;
            const num = await extractIdNumber(target);
            const best = num.number ?? num.repaired;
            if (best) {
              patch.idNumber = best;
              patch.idNumberValid = num.valid;
              if (num.valid) idFound++;
            }
          } catch { /* 号码提取失败不阻断判面流程 */ }
        }
        updateCard(c.id, patch);
      }
      notify(
        `识别完成${flipped ? ` · 已自动翻正 ${flipped} 张` : ''}` +
        (idFound ? ` · ${idFound} 张号码通过校验` : '') +
        ' · 可手动修正正反面',
      );
    } catch (e) { notify(`识别失败：${errText(e)}`, 'err'); }
    finally { setBusy(false); setStatus(''); }
  }, [cards, busy, notify, updateCard]);

  const generate = useCallback(async (action: 'workspace' | 'save') => {
    if (!cards.length || busy) { if (!cards.length) notify('请先添加图片', 'err'); return; }
    setBusy(true);
    setStatus('正在生成 A4 PDF…');
    try {
      const bytes = await buildIdCardPdf(cards, opts);
      const name = '身份证复印件-A4.pdf';
      if (action === 'save') {
        const ok = await savePdf(name, bytes);
        notify(ok ? `已导出 · ${(bytes.length / 1024).toFixed(0)} KB` : '已取消保存', ok ? 'ok' : 'err');
      } else {
        await onAddToWorkspace(name, bytes);
        notify('已加入工作区，可继续合并 / 导出');
        onClose();
      }
    } catch (e) { notify(`生成失败：${errText(e)}`, 'err'); }
    finally { setBusy(false); setStatus(''); }
  }, [cards, busy, opts, notify, onAddToWorkspace, onClose]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>, card: IdCardSource) => {
    const rect = e.currentTarget.getBoundingClientRect();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: card.id, x: e.clientX, y: e.clientY,
      cropX: card.crop.x, cropY: card.crop.y, w: rect.width, h: rect.height,
    };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const c = cardsRef.current.find((v) => v.id === d.id);
    if (!c) return;
    const dx = (e.clientX - d.x) / d.w, dy = (e.clientY - d.y) / d.h;
    updateCard(d.id, { crop: panCrop({ ...c.crop, x: d.cropX, y: d.cropY }, dx, dy) });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void addFiles(Array.from(e.dataTransfer.files));
  };

  const ordered = useMemo(() => sortCards(cards), [cards]);
  const pageCount = useMemo(
    () => layoutPlacements(cards.length, opts.perPage, opts.gapMm).length,
    [cards.length, opts.perPage, opts.gapMm],
  );
  const duplicateSide = cards.length > 1 && new Set(cards.map((c) => c.side)).size < cards.length;
  const unlocated = cards.filter((c) => c.locate && !c.locate.ok).length;

  return (
    <div className="modal-backdrop">
      <div className="modal modal-idcard">
        <div className="modal-head">
          <div>
            <h3>身份证复印件 · A4 实际尺寸</h3>
            <span>A4 210 × 297 mm · 每张 85.6 × 54 mm · 打印请选「实际大小 / 100%」· 全程本机处理</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="idcard-controls">
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()} disabled={busy}>添加证件照片</button>
            <button className="btn" onClick={() => void detectAll()} disabled={busy || !cards.length}>
              自动识别正反面
            </button>
            <button className="btn" onClick={clearAll} disabled={busy || !cards.length}>清空</button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden
              onChange={(e) => { void addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
          </div>
          <div className="idcard-opts">
            <label>每页
              <select value={opts.perPage} disabled={busy}
                onChange={(e) => setOpts({ ...opts, perPage: Number(e.target.value) as 1 | 2 })}>
                <option value={2}>2 张（正反面上下）</option>
                <option value={1}>1 张（居中）</option>
              </select>
            </label>
            <label>间距 <b>{opts.gapMm} mm</b>
              <input type="range" min="0" max="40" step="2" value={opts.gapMm} disabled={busy}
                onChange={(e) => setOpts({ ...opts, gapMm: Number(e.target.value) })} />
            </label>
            <label className="check idcard-check">
              <input type="checkbox" checked={opts.label} disabled={busy}
                onChange={(e) => setOpts({ ...opts, label: e.target.checked })} />
              <span><strong>面别标注</strong></span>
            </label>
          </div>
          {busy && status && <div className="ocr-summary">{status}</div>}
        </div>

        <div className={`idcard-body${dragOver ? ' is-dragover' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
          onDrop={onDrop}>
          {cards.length === 0 ? (
            <div className="idcard-empty">
              <strong>把身份证正反面照片拖进来</strong>
              <p>导入时会自动在照片里找出证件、裁掉多余背景，并把竖拍的证件转正；「成品预览」就是最终进 PDF 的画面。照片拍歪了可在每张卡片下方手写旋转角度，正数右转、负数左转。</p>
              <p>每张照片都可切到「原图框选」：整张照片上会显示高亮取景框，能直接拖到证件上、拖右下角缩放；定位存疑时会自动切到这个视图。自动识别正反面使用应用内置的离线中文 OCR，识别不准可直接在下拉框手动指定。</p>
            </div>
          ) : (
            <div className="idcard-grid">
              {cards.map((card) => (
                <div className="idcard-item" key={card.id}>
                  <div className="idcard-tabs">
                    <button className={`idcard-tab${(viewMode[card.id] ?? 'result') === 'result' ? ' active' : ''}`}
                      onClick={() => setViewMode((v) => ({ ...v, [card.id]: 'result' }))}>成品预览</button>
                    <button className={`idcard-tab${viewMode[card.id] === 'frame' ? ' active' : ''}`}
                      onClick={() => setViewMode((v) => ({ ...v, [card.id]: 'frame' }))}>原图框选</button>
                    <span className="muted small">框选视图可直接把取景框拖到证件上</span>
                  </div>
                  {viewMode[card.id] === 'frame' ? (
                    <IdCardFrameEditor card={card}
                      onChange={(crop) => updateCard(card.id, { crop })} />
                  ) : (
                    <div className="idcard-viewport"
                      onPointerDown={(e) => onPointerDown(e, card)}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onPointerCancel={onPointerUp}>
                      <CardPreview card={card} />
                      <span className="idcard-ratio">85.6 × 54 mm</span>
                    </div>
                  )}
                  <div className="idcard-meta">
                    <div className="idcard-name" title={card.name}>{card.name}</div>
                    {card.locate && (
                      <div className={`idcard-locate${card.locate.ok ? ' ok' : ' warn'}`}>
                        {card.locate.ok ? '✓ ' : '! '}{card.locate.reason}
                      </div>
                    )}
                    <div className="idcard-row">
                      <select value={card.side}
                        onChange={(e) => updateCard(card.id, { side: e.target.value as CardSide, detectedBy: 'manual' })}>
                        <option value="front">人像面</option>
                        <option value="back">国徽面</option>
                        <option value="unknown">未指定</option>
                      </select>
                      <button className="btn btn-small" title="重新自动定位证件区域"
                        onClick={() => relocate(card.id)}>重新定位</button>
                      <button className="btn btn-small" title="把取景框还原为整张照片（最小裁切）"
                        onClick={() => updateCard(card.id, {
                          crop: minimalCrop(card.base.width, card.base.height),
                        })}>整图</button>
                      <button className="btn btn-small btn-danger" onClick={() => removeCard(card.id)}>移除</button>
                    </div>
                    <div className="idcard-angle">
                      <span className="idcard-angle-label">旋转</span>
                      <button className="btn btn-small" title="逆时针整步旋转 90° 并重新定位"
                        disabled={busy} onClick={() => rotate(card.id, -90)}>↺ 90°</button>
                      <button className="btn btn-small" title="顺时针整步旋转 90° 并重新定位"
                        disabled={busy} onClick={() => rotate(card.id, 90)}>↻ 90°</button>
                      <input className="idcard-angle-input" type="number"
                        min="-180" max="180" step="0.1" placeholder="角度"
                        aria-label="自定义旋转角度（正数顺时针，负数逆时针）"
                        value={angleDraft[card.id] ?? fmtAngle(card.angle)}
                        disabled={busy}
                        onChange={(e) => setAngleDraft((d) => ({ ...d, [card.id]: e.target.value }))}
                        onBlur={() => applyAngle(card.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                        }} />
                      <span className="idcard-angle-unit">°</span>
                      <button className="btn btn-small" disabled={busy}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => applyAngle(card.id)}>应用</button>
                      <button className="btn btn-small" disabled={busy}
                        title="清除手写角度，回到自动转正后的方向"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setAngle(card.id, 0); clearDraft(card.id); }}>复位</button>
                    </div>
                    <div className="idcard-angle-hint">
                      正数顺时针（右转）、负数逆时针（左转），可输入小数如 -2.5；回车或点「应用」生效。
                      90° 的整数倍会自动整步转正并重新定位
                      {card.angle !== 0 && (
                        <> · 当前 <b>{fmtAngle(card.angle)}°</b>{card.angle > 0 ? ' 顺时针' : ' 逆时针'}</>
                      )}
                    </div>
                    <label className="idcard-scale">取景范围 <b>{Math.round(card.crop.w * 100)}%</b>
                      <span className="muted"> · 数值越小越放大</span>
                      <input type="range" min="8" max="100" step="1"
                        value={Math.max(8, Math.min(100, Math.round(card.crop.w * 100)))}
                        onChange={(e) => {
                          const target = Number(e.target.value) / 100;
                          updateCard(card.id, {
                            crop: zoomCrop(card.crop, target / card.crop.w, card.base.width, card.base.height),
                          });
                        }} />
                    </label>
                    {card.detectedBy && (
                      <div className="idcard-detect">
                        {card.detectedBy === 'ocr' ? 'OCR 判定' : card.detectedBy === 'name' ? '按文件名判定' : '手动指定'}
                        {' · '}{SIDE_LABEL[card.side]}
                        {card.ocrText && <span title={card.ocrText}> · 识别到 {card.ocrText.length} 字</span>}
                      </div>
                    )}
                    {card.idNumber && (
                      <div className="idcard-detect">
                        号码：<b className="mono">{card.idNumber}</b>
                        {card.idNumberValid
                          ? <span title="MOD 11-2 校验通过"> · ✓ 校验通过</span>
                          : <span title="号码未通过校验码验证，请人工核对"> · ⚠ 未过校验</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="idcard-footbar">
          <div className="idcard-order">
            <span className="muted small">输出顺序：</span>
            {ordered.length
              ? ordered.map((c, i) => <span key={c.id} className="idcard-chip">{i + 1}. {SIDE_LABEL[c.side]}</span>)
              : <span className="muted small">尚未添加</span>}
            <span className="muted small">· 共 {pageCount} 页 A4</span>
            {duplicateSide && <span className="idcard-warn">有两张同面，请检查</span>}
            {unlocated > 0 && <span className="idcard-warn">{unlocated} 张定位存疑，请在「原图框选」确认</span>}
          </div>
          <div className="btn-row">
            <button className="btn" onClick={() => void generate('save')} disabled={busy || !cards.length}>直接保存 PDF</button>
            <button className="btn btn-primary" onClick={() => void generate('workspace')} disabled={busy || !cards.length}>
              加入工作区
            </button>
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        </div>
      </div>
    </div>
  );
}
