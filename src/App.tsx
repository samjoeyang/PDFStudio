import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import { buildPdf, getPageCount } from './lib/pdf';
import { clearThumbCache } from './lib/thumb';
import { onOpenFiles, readFileBytes, savePdf } from './lib/platform';
import { useHistory } from './lib/history';
import { applyAnnotations, rasterizePdf } from './lib/raster';
import type { PageLayers } from './lib/raster';
import { DEFAULT_WATERMARK } from './lib/watermark';
import type { WatermarkSettings } from './lib/watermark';
import type { Annotation, DocItem, PageItem } from './lib/types';
import PageCard from './components/PageCard';
import AnnotationEditor from './components/AnnotationEditor';
import OcrPanel from './components/OcrPanel';
import IdCardPanel from './components/IdCardPanel';
import WatermarkPanel from './components/WatermarkPanel';
import './styles.css';

let seq = 0;
const uid = () => `${Date.now().toString(36)}-${(seq++).toString(36)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface OcrPanelState {
  bytes: Uint8Array;
  pageCount: number;
  label: string;
}

export default function App() {
  const { state, commit, undo, redo, reset, canUndo, canRedo } = useHistory();
  const { docs, pages, annotations } = state;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('就绪 · 所有处理都在本机完成');
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const [optimize, setOptimize] = useState(true);
  const [compressMode, setCompressMode] = useState<'none' | 'raster'>('none');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.7);
  const [dragOver, setDragOver] = useState(false);
  const [editorPageId, setEditorPageId] = useState<string | null>(null);
  const [ocrPanel, setOcrPanel] = useState<OcrPanelState | null>(null);
  const [idCardOpen, setIdCardOpen] = useState(false);
  const [watermark, setWatermark] = useState<WatermarkSettings>(DEFAULT_WATERMARK);
  const [watermarkOpen, setWatermarkOpen] = useState(false);

  const pdfInput = useRef<HTMLInputElement>(null);
  const dragId = useRef<string | null>(null);
  const lastSelected = useRef<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  const notify = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    setToast({ text, kind });
    setStatus(text);
  }, []);

  const docMap = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);
  const countByDoc = useMemo(() => {
    const m = new Map<string, number>();
    pages.forEach((p) => m.set(p.docId, (m.get(p.docId) ?? 0) + 1));
    return m;
  }, [pages]);
  const annotByPage = useMemo(() => {
    const m = new Map<string, number>();
    annotations.forEach((a) => m.set(a.pageId, (m.get(a.pageId) ?? 0) + 1));
    return m;
  }, [annotations]);

  const appendPdf = useCallback(async (name: string, bytes: Uint8Array) => {
    const count = await getPageCount(bytes);
    const doc: DocItem = { id: uid(), name, bytes, pageCount: count };
    const added: PageItem[] = Array.from({ length: count }, (_, i) => ({
      id: uid(), docId: doc.id, pageIndex: i, rotation: 0,
    }));
    commit((prev) => ({
      ...prev,
      docs: [...prev.docs, doc],
      pages: [...prev.pages, ...added],
    }));
    return count;
  }, [commit]);

  const handlePdfFiles = useCallback(async (files: File[]) => {
    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) { notify('请选择 PDF 文件', 'err'); return; }
    setBusy(true);
    setStatus('正在读取 PDF…');
    try {
      let total = 0;
      for (const f of pdfs) {
        total += await appendPdf(f.name, new Uint8Array(await f.arrayBuffer()));
      }
      notify(`已加入 ${pdfs.length} 个文档、${total} 页`);
    } catch (e) { notify(`打开失败：${errText(e)}`, 'err'); }
    finally { setBusy(false); }
  }, [appendPdf, notify]);

  const handleDropFiles = useCallback(async (files: File[]) => {
    const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (!pdfs.length) { notify('只支持 PDF 文件', 'err'); return; }
    await handlePdfFiles(pdfs);
  }, [handlePdfFiles, notify]);

  useEffect(() => onOpenFiles((paths) => {
    void (async () => {
      setBusy(true);
      for (const p of paths) {
        try {
          const name = p.split(/[\\/]/).pop() || 'document.pdf';
          await appendPdf(name, await readFileBytes(p));
        } catch (e) { notify(`打开失败：${errText(e)}`, 'err'); }
      }
      setBusy(false);
    })();
  }), [appendPdf, notify]);

  const onSelect = useCallback((id: string, e: MouseEvent) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastSelected.current) {
        const a = pages.findIndex((p) => p.id === lastSelected.current);
        const b = pages.findIndex((p) => p.id === id);
        if (a >= 0 && b >= 0) {
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(pages[i].id);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(id)) next.delete(id); else next.add(id);
      } else {
        if (next.has(id) && next.size === 1) next.clear();
        else { next.clear(); next.add(id); }
      }
      return next;
    });
    lastSelected.current = id;
  }, [pages]);

  const onCardDragStart = useCallback((e: DragEvent, id: string) => {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const onCardDrop = useCallback((e: DragEvent, targetId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const srcId = dragId.current || e.dataTransfer.getData('text/plain');
    dragId.current = null;
    if (!srcId || srcId === targetId) return;
    commit((prev) => {
      const from = prev.pages.findIndex((p) => p.id === srcId);
      const to = prev.pages.findIndex((p) => p.id === targetId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev.pages];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { ...prev, pages: next };
    });
  }, [commit]);

  const rotate = useCallback((delta: number) => {
    if (!selected.size) { notify('请先选择页面', 'err'); return; }
    commit((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => (
        selected.has(p.id) ? { ...p, rotation: (p.rotation + delta + 360) % 360 } : p
      )),
    }));
  }, [selected, commit, notify]);

  const removeSelected = useCallback(() => {
    if (!selected.size) return;
    const ids = new Set(selected);
    commit((prev) => ({
      ...prev,
      pages: prev.pages.filter((p) => !ids.has(p.id)),
      annotations: prev.annotations.filter((a) => !ids.has(a.pageId)),
    }));
    setSelected(new Set());
    notify('已删除选中页');
  }, [selected, commit, notify]);

  const removeDoc = useCallback((docId: string) => {
    commit((prev) => {
      const removed = new Set(prev.pages.filter((p) => p.docId === docId).map((p) => p.id));
      return {
        docs: prev.docs.filter((d) => d.id !== docId),
        pages: prev.pages.filter((p) => p.docId !== docId),
        annotations: prev.annotations.filter((a) => !removed.has(a.pageId)),
      };
    });
    setSelected(new Set());
    clearThumbCache(docId);
    notify('已移除该文档的全部页面');
  }, [commit, notify]);

  const reAddDoc = useCallback((doc: DocItem) => {
    commit((prev) => ({
      ...prev,
      pages: [...prev.pages, ...Array.from({ length: doc.pageCount }, (_, i) => ({
        id: uid(), docId: doc.id, pageIndex: i, rotation: 0,
      }))],
    }));
    notify(`已重新加入 ${doc.pageCount} 页`);
  }, [commit, notify]);

  const clearAll = useCallback(() => {
    reset();
    setSelected(new Set());
    clearThumbCache();
    notify('工作区已清空');
  }, [reset, notify]);

  const saveAnnotations = useCallback((pageId: string, anns: Annotation[]) => {
    commit((prev) => ({
      ...prev,
      annotations: [...prev.annotations.filter((a) => a.pageId !== pageId), ...anns],
    }));
    setEditorPageId(null);
    notify(`已保存 ${anns.length} 条批注`);
  }, [commit, notify]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault(); redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size) {
        e.preventDefault(); removeSelected();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, selected, removeSelected]);

  const exportList = useCallback((scope: 'all' | 'selected') => (
    scope === 'all' ? pages : pages.filter((p) => selected.has(p.id))
  ), [pages, selected]);

  /** 生成导出用 PDF；withRaster=false 时保留矢量，供文字提取 / OCR 使用 */
  const buildBase = useCallback(async (scope: 'all' | 'selected', withRaster = true) => {
    const list = exportList(scope);
    if (!list.length) throw new Error('没有可用的页面');
    let bytes = await buildPdf(list, docs, optimize);
    const overlays = new Map<number, Annotation[]>();
    list.forEach((p, i) => {
      const a = annotations.filter((x) => x.pageId === p.id);
      if (a.length) overlays.set(i, a);
    });
    // 水印按导出后的页序定位：scope=selected 时只对仍被选中的页生效
    const layers: PageLayers | undefined = watermark.enabled ? {
      watermark,
      watermarkPages: new Set(
        list.reduce<number[]>((acc, p, i) => {
          if (watermark.scope === 'all' || selected.has(p.id)) acc.push(i);
          return acc;
        }, []),
      ),
    } : undefined;
    if (withRaster && compressMode === 'raster') {
      bytes = await rasterizePdf(bytes, { dpi, quality }, overlays,
        (done, total) => setStatus(`图像压缩中 ${done}/${total} 页`), layers);
    } else if (withRaster) {
      // 内部若无任何目标页会原样返回；OCR 用的 withRaster=false 完全不叠加
      bytes = await applyAnnotations(bytes, overlays, undefined, layers);
    }
    return { bytes, count: list.length };
  }, [exportList, docs, optimize, annotations, compressMode, dpi, quality, watermark, selected]);

  const doExport = useCallback(async (scope: 'all' | 'selected') => {
    setBusy(true);
    setStatus('正在生成 PDF…');
    try {
      const { bytes, count } = await buildBase(scope);
      const name = scope === 'all' ? 'PDF Studio-合并.pdf' : 'PDF Studio-选页.pdf';
      const ok = await savePdf(name, bytes);
      notify(ok ? `已导出 ${count} 页 · ${(bytes.length / 1024).toFixed(0)} KB` : '已取消保存', ok ? 'ok' : 'err');
    } catch (e) { notify(`导出失败：${errText(e)}`, 'err'); }
    finally { setBusy(false); }
  }, [buildBase, notify]);

  const openOcr = useCallback(async () => {
    const scope = selected.size ? 'selected' : 'all';
    setBusy(true);
    setStatus('正在准备文字提取…');
    try {
      const { bytes, count } = await buildBase(scope, false);
      setOcrPanel({
        bytes,
        pageCount: count,
        label: scope === 'all' ? '全部页面' : `选中的 ${count} 页`,
      });
      notify('已打开文字提取面板');
    } catch (e) { notify(`准备失败：${errText(e)}`, 'err'); }
    finally { setBusy(false); }
  }, [selected.size, buildBase, notify]);

  const watermarkPreview = useMemo(() => {
    const first = pages[0];
    if (!first) return null;
    const doc = docMap.get(first.docId);
    return doc ? { bytes: doc.bytes, pageIndex: first.pageIndex } : null;
  }, [pages, docMap]);

  const editorPage = editorPageId ? pages.find((p) => p.id === editorPageId) : undefined;
  const editorDoc = editorPage ? docMap.get(editorPage.docId) : undefined;
  const editorOrder = editorPage ? pages.findIndex((p) => p.id === editorPage.id) : -1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">P</div>
          <div>
            <div className="brand-title">PDF Studio</div>
            <div className="brand-sub">本地优先的桌面 PDF 工作台</div>
          </div>
        </div>
        <div className="toolbar">
          <button className="btn" onClick={() => pdfInput.current?.click()} disabled={busy}>打开 PDF</button>
          <button className="btn" onClick={() => setIdCardOpen(true)} disabled={busy}>身份证排版</button>
          <span className="divider" />
          <button className="btn" onClick={undo} disabled={!canUndo || busy} title="撤销 Ctrl/⌘+Z">撤销</button>
          <button className="btn" onClick={redo} disabled={!canRedo || busy} title="重做 Ctrl/⌘+Shift+Z">重做</button>
          <button className={`btn${watermark.enabled ? ' is-on' : ''}`}
            onClick={() => setWatermarkOpen(true)} disabled={busy || !pages.length}>
            水印{watermark.enabled ? ' · 已启用' : ''}
          </button>
          <button className="btn" onClick={() => void openOcr()} disabled={busy || !pages.length}>文字 / OCR</button>
          <span className="divider" />
          <button className="btn" onClick={() => void doExport('selected')} disabled={busy || !selected.size}>导出选中</button>
          <button className="btn btn-primary" onClick={() => void doExport('all')} disabled={busy || !pages.length}>导出全部</button>
        </div>
        <input ref={pdfInput} type="file" accept=".pdf,application/pdf" multiple hidden
          onChange={(e) => { void handlePdfFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      </header>

      <div className="body">
        <aside className="sidebar">
          <div className="panel-head"><span>文档</span><span className="count">{docs.length}</span></div>
          <div className="doc-list">
            {docs.length === 0 && <div className="empty-hint">还没有打开任何文档</div>}
            {docs.map((d, i) => (
              <div className="doc-item" key={d.id}>
                <div className="doc-index">{i + 1}</div>
                <div className="doc-info">
                  <div className="doc-name" title={d.name}>{d.name}</div>
                  <div className="doc-sub">
                    PDF · 共 {d.pageCount} 页 · 工作区 {countByDoc.get(d.id) ?? 0} 页
                  </div>
                  <div className="doc-actions">
                    <button onClick={() => reAddDoc(d)}>重新加入</button>
                    <button onClick={() => removeDoc(d.id)}>移除</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {docs.length > 0 && <button className="btn btn-ghost btn-block" onClick={clearAll}>清空工作区</button>}
          <div className="sidebar-note">文档按列表顺序拼接，页面网格里的顺序即最终导出顺序。</div>
        </aside>

        <main
          className={`workspace${dragOver ? ' is-dragover' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
          onDrop={(e) => {
            e.preventDefault(); setDragOver(false);
            if (e.dataTransfer.files.length) void handleDropFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {pages.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">PDF</div>
              <h2>把 PDF 拖进来，开始整理</h2>
              <p>合并 · 重排 · 拆分 · 旋转 · 批注签名 · 文字提取与 OCR · 图像压缩</p>
              <div className="empty-actions">
                <button className="btn btn-primary" onClick={() => pdfInput.current?.click()}>打开 PDF</button>
              </div>
              <div className="empty-foot">所有处理在本机完成，文件不会上传；OCR 引擎与语言包已内置</div>
            </div>
          ) : (
            <div className="page-grid">
              {pages.map((p, i) => {
                const doc = docMap.get(p.docId);
                if (!doc) return null;
                return (
                  <PageCard
                    key={p.id} page={p} doc={doc} order={i}
                    selected={selected.has(p.id)}
                    annotationCount={annotByPage.get(p.id) ?? 0}
                    onSelect={onSelect}
                    onDragStart={onCardDragStart}
                    onDrop={onCardDrop}
                    onOpenEditor={setEditorPageId}
                  />
                );
              })}
            </div>
          )}
          {dragOver && <div className="drop-mask">松开即可加入工作区</div>}
        </main>

        <aside className="inspector">
          <div className="panel-head">工作区</div>
          <div className="stats">
            <div><span>文档</span><strong>{docs.length}</strong></div>
            <div><span>页面</span><strong>{pages.length}</strong></div>
            <div><span>已选</span><strong>{selected.size}</strong></div>
          </div>

          <div className="panel-section">
            <div className="section-title">选择</div>
            <div className="btn-row">
              <button className="btn btn-small" onClick={() => setSelected(new Set(pages.map((p) => p.id)))} disabled={!pages.length}>全选</button>
              <button className="btn btn-small" onClick={() => setSelected(new Set(pages.filter((p) => !selected.has(p.id)).map((p) => p.id)))} disabled={!pages.length}>反选</button>
              <button className="btn btn-small" onClick={() => setSelected(new Set())} disabled={!selected.size}>清除</button>
            </div>
          </div>

          <div className="panel-section">
            <div className="section-title">页面操作</div>
            <div className="btn-row">
              <button className="btn btn-small" onClick={() => rotate(-90)} disabled={!selected.size}>左转 90°</button>
              <button className="btn btn-small" onClick={() => rotate(90)} disabled={!selected.size}>右转 90°</button>
            </div>
            <button className="btn btn-small btn-block" disabled={selected.size !== 1}
              onClick={() => { const only = [...selected][0]; if (only) setEditorPageId(only); }}>
              批注 / 签名
            </button>
            <button className="btn btn-small btn-danger btn-block" onClick={removeSelected} disabled={!selected.size}>删除选中页</button>
          </div>

          <div className="panel-section">
            <div className="section-title">导出选项</div>
            <label className="check">
              <input type="checkbox" checked={optimize} onChange={(e) => setOptimize(e.target.checked)} />
              <span><strong>优化体积</strong><small>启用对象流并清理元数据</small></span>
            </label>
            <label className="check">
              <input type="checkbox" checked={compressMode === 'raster'}
                onChange={(e) => setCompressMode(e.target.checked ? 'raster' : 'none')} />
              <span><strong>图像重编码压缩</strong><small>大幅减小扫描件体积，会丢失文本层</small></span>
            </label>
            {compressMode === 'raster' && (
              <div className="slider-box">
                <label>分辨率 <b>{dpi} DPI</b>
                  <input type="range" min="72" max="300" step="10" value={dpi}
                    onChange={(e) => setDpi(Number(e.target.value))} />
                </label>
                <label>JPEG 质量 <b>{Math.round(quality * 100)}%</b>
                  <input type="range" min="0.3" max="0.95" step="0.05" value={quality}
                    onChange={(e) => setQuality(Number(e.target.value))} />
                </label>
              </div>
            )}
          </div>

          <div className="panel-section tips">
            <div className="section-title">提示</div>
            <p>双击页面卡片可添加批注与签名（{annotations.length} 条）</p>
            <p>Ctrl / ⌘ + Z 撤销，Shift 连选，Delete 删除</p>
            <p>只导出选中页即可完成拆分提取</p>
          </div>
        </aside>
      </div>

      <footer className="statusbar">
        <span className={`status-dot${busy ? ' is-busy' : ''}`} />
        <span className="status-text">{busy ? '处理中… ' : ''}{status}</span>
        <span className="status-right">PDF Studio 0.2.0 · 离线运行</span>
      </footer>

      {toast && <div className={`toast is-${toast.kind}`}>{toast.text}</div>}
      {busy && <div className="busy-mask"><span>正在处理…</span></div>}

      {editorPage && editorDoc && (
        <AnnotationEditor
          page={editorPage} doc={editorDoc} order={editorOrder}
          initial={annotations.filter((a) => a.pageId === editorPage.id)}
          onSave={(anns) => saveAnnotations(editorPage.id, anns)}
          onClose={() => setEditorPageId(null)}
        />
      )}
      {ocrPanel && (
        <OcrPanel
          baseBytes={ocrPanel.bytes}
          pageCount={ocrPanel.pageCount}
          scopeLabel={ocrPanel.label}
          notify={notify}
          onClose={() => setOcrPanel(null)}
        />
      )}
      {idCardOpen && (
        <IdCardPanel
          notify={notify}
          onClose={() => setIdCardOpen(false)}
          onAddToWorkspace={async (name, bytes) => { await appendPdf(name, bytes); }}
        />
      )}
      {watermarkOpen && (
        <WatermarkPanel
          settings={watermark}
          onChange={setWatermark}
          preview={watermarkPreview}
          selectedCount={selected.size}
          onClose={() => setWatermarkOpen(false)}
        />
      )}
    </div>
  );
}
