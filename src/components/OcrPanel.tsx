import { useMemo, useState } from 'react';
import { extractPages, makeSearchablePdf, resultsToTxt, DEFAULT_OCR_SETTINGS } from '../lib/ocr';
import type { ExtractMode, OcrSettings, OcrLang, OcrPsm } from '../lib/ocr';
import type { PreprocessMode } from '../lib/preprocess';
import { savePdf, saveText } from '../lib/platform';
import type { OcrResult } from '../lib/types';

interface Props {
  baseBytes: Uint8Array;
  pageCount: number;
  scopeLabel: string;
  onClose: () => void;
  notify: (text: string, kind?: 'ok' | 'err') => void;
}

interface Progress { done: number; total: number; status: string }

const MODES: { id: ExtractMode; label: string; hint: string }[] = [
  { id: 'smart', label: '智能', hint: '先读文本层，扫描页自动 OCR' },
  { id: 'layer', label: '仅文本层', hint: '秒级，适合电子版 PDF' },
  { id: 'ocr', label: '全部 OCR', hint: '逐页识别，适合扫描件' },
];

const DPI_OPTIONS = [200, 300, 350, 400, 500];
const PREP_OPTIONS: { id: PreprocessMode; label: string; hint: string }[] = [
  { id: 'auto', label: '自动', hint: '按需二值化 / 去噪 / 纠偏 / 反相' },
  { id: 'gray', label: '灰度增强', hint: '对比度拉伸 + 去噪' },
  { id: 'binary', label: '二值化', hint: '适合阴影、光照不均的翻拍件' },
  { id: 'none', label: '原图', hint: '不做任何处理，最快' },
];
const PSM_OPTIONS: { id: OcrPsm; label: string }[] = [
  { id: 'block', label: '整块文字（推荐）' },
  { id: 'column', label: '单栏' },
  { id: 'auto', label: '自动版面分析' },
  { id: 'sparse', label: '稀疏文字 / 表单' },
];
const LANG_OPTIONS: { id: OcrLang; label: string }[] = [
  { id: 'chi+eng', label: '中文 + 英文' },
  { id: 'chi', label: '仅中文' },
  { id: 'eng', label: '仅英文' },
];

export default function OcrPanel({ baseBytes, pageCount, scopeLabel, onClose, notify }: Props) {
  const [mode, setMode] = useState<ExtractMode>('smart');
  const [settings, setSettings] = useState<OcrSettings>(DEFAULT_OCR_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [results, setResults] = useState<OcrResult[]>([]);
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0, status: '' });
  const [running, setRunning] = useState(false);
  const [activePage, setActivePage] = useState(1);
  const [query, setQuery] = useState('');

  const patch = <K extends keyof OcrSettings>(key: K, value: OcrSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const matched = useMemo(() => {
    if (!query.trim()) return results;
    const q = query.trim().toLowerCase();
    return results.filter((r) => r.text.toLowerCase().includes(q));
  }, [results, query]);

  const current = results.find((r) => r.pageNumber === activePage);
  const totalChars = results.reduce((n, r) => n + r.text.length, 0);
  const ocrPages = results.filter((r) => r.source === 'ocr').length;
  const multiCol = results.filter((r) => (r.columns ?? 1) > 1).length;

  const run = async () => {
    if (running || pageCount === 0) return;
    setRunning(true);
    setResults([]);
    try {
      const nums = Array.from({ length: pageCount }, (_, i) => i + 1);
      const res = await extractPages(baseBytes, nums, mode,
        (done, total, status) => setProgress({ done, total, status }), settings);
      setResults(res);
      if (res.length) setActivePage(res[0].pageNumber);
      notify(`提取完成 · ${res.length} 页 · ${res.reduce((n, r) => n + r.text.length, 0)} 字符`);
    } catch (e) {
      notify(`提取失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      setRunning(false);
      setProgress({ done: 0, total: 0, status: '' });
    }
  };

  const exportTxt = async () => {
    if (!results.length) return;
    const ok = await saveText('PDF Studio-文字提取.txt', new TextEncoder().encode(resultsToTxt(results)));
    notify(ok ? 'TXT 已导出' : '已取消', ok ? 'ok' : 'err');
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(resultsToTxt(results));
      notify('全文已复制到剪贴板');
    } catch {
      notify('复制失败，请使用导出 TXT', 'err');
    }
  };

  const exportSearchable = async () => {
    if (!results.length) return;
    setRunning(true);
    setProgress({ done: 0, total: 1, status: '正在写入隐藏文本层…' });
    try {
      const bytes = await makeSearchablePdf(baseBytes, results);
      const ok = await savePdf('PDF Studio-可搜索.pdf', bytes);
      notify(ok ? '可搜索 PDF 已导出' : '已取消', ok ? 'ok' : 'err');
    } catch (e) {
      notify(`生成失败：${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      setRunning(false);
      setProgress({ done: 0, total: 0, status: '' });
    }
  };

  const highlight = (text: string) => {
    if (!query.trim()) return text;
    const q = query.trim();
    return text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
      .map((part, i) => part.toLowerCase() === q.toLowerCase()
        ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal modal-ocr">
        <div className="modal-head">
          <div>
            <h3>文字提取与 OCR</h3>
            <span>{scopeLabel} · 共 {pageCount} 页 · 高精度离线引擎</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="ocr-controls">
          <div className="mode-row">
            {MODES.map((m) => (
              <button key={m.id} className={`mode-card${mode === m.id ? ' is-active' : ''}`}
                onClick={() => setMode(m.id)} disabled={running}>
                <strong>{m.label}</strong>
                <small>{m.hint}</small>
              </button>
            ))}
          </div>

          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => void run()} disabled={running || !pageCount}>
              {running ? '处理中…' : '开始提取'}
            </button>
            <button className={`btn${showSettings ? ' is-on' : ''}`} onClick={() => setShowSettings(!showSettings)}>
              识别设置
            </button>
            <button className="btn" onClick={() => void exportTxt()} disabled={!results.length || running}>导出 TXT</button>
            <button className="btn" onClick={() => void copyAll()} disabled={!results.length || running}>复制全文</button>
            <button className="btn" onClick={() => void exportSearchable()} disabled={!results.length || running}>
              生成可搜索 PDF
            </button>
          </div>

          {showSettings && (
            <div className="ocr-settings">
              <div className="settings-grid">
                <label>
                  <span>渲染分辨率</span>
                  <select value={settings.dpi} disabled={running}
                    onChange={(e) => patch('dpi', Number(e.target.value))}>
                    {DPI_OPTIONS.map((d) => <option key={d} value={d}>{d} DPI{d === 350 ? '（推荐）' : ''}</option>)}
                  </select>
                  <small>小字 / 扫描件用 350~400；越高越慢</small>
                </label>
                <label>
                  <span>图像预处理</span>
                  <select value={settings.preprocess} disabled={running}
                    onChange={(e) => patch('preprocess', e.target.value as PreprocessMode)}>
                    {PREP_OPTIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  <small>{PREP_OPTIONS.find((p) => p.id === settings.preprocess)?.hint}</small>
                </label>
                <label>
                  <span>版面分析</span>
                  <select value={settings.psm} disabled={running}
                    onChange={(e) => patch('psm', e.target.value as OcrPsm)}>
                    {PSM_OPTIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                  <small>票据、表单可选「稀疏文字」</small>
                </label>
                <label>
                  <span>识别语言</span>
                  <select value={settings.lang} disabled={running}
                    onChange={(e) => patch('lang', e.target.value as OcrLang)}>
                    {LANG_OPTIONS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                  <small>纯中文文档选「仅中文」更准</small>
                </label>
              </div>
              <div className="settings-foot">
                <label className="checkline">
                  <input type="checkbox" checked={settings.layout} disabled={running}
                    onChange={(e) => patch('layout', e.target.checked)} />
                  多栏文档按坐标还原阅读顺序
                </label>
                <button className="link-btn" onClick={() => setSettings(DEFAULT_OCR_SETTINGS)} disabled={running}>
                  恢复默认
                </button>
              </div>
            </div>
          )}

          {running && (
            <div className="progress-line">
              <div className="progress-bar"><span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 8}%` }} /></div>
              <small>{progress.status} {progress.total ? `${progress.done}/${progress.total}` : ''}</small>
            </div>
          )}
          {!running && results.length > 0 && (
            <div className="ocr-summary">
              {results.length} 页 · {totalChars} 字符
              {ocrPages > 0 && ` · ${ocrPages} 页来自 OCR`}
              {ocrPages > 0 && ` · 平均置信度 ${Math.round(results.filter(r => r.source === 'ocr').reduce((n, r) => n + r.confidence, 0) / ocrPages)}%`}
              {multiCol > 0 && ` · ${multiCol} 页已重排多栏`}
            </div>
          )}
        </div>

        <div className="ocr-body">
          <div className="ocr-pages">
            <div className="section-title">页面 {query && `· 命中 ${matched.length}`}</div>
            <input className="search-input" value={query} placeholder="搜索全文…"
              onChange={(e) => setQuery(e.target.value)} />
            <div className="ocr-page-list">
              {results.length === 0 && <p className="muted small">点击「开始提取」后显示结果</p>}
              {matched.map((r) => (
                <button key={r.pageNumber}
                  className={`ocr-page-item${activePage === r.pageNumber ? ' is-active' : ''}`}
                  onClick={() => setActivePage(r.pageNumber)}>
                  <span>第 {r.pageNumber} 页</span>
                  <small>
                    {r.source === 'ocr' ? `OCR ${Math.round(r.confidence)}%` : '文本层'} · {r.text.length} 字
                    {(r.columns ?? 1) > 1 && ` · ${r.columns} 栏`}
                    {r.angle ? ` · 纠偏 ${r.angle}°` : ''}
                    {(r.upscale ?? 1) > 1 ? ` · ${r.upscale}× 放大` : ''}
                  </small>
                </button>
              ))}
            </div>
          </div>
          <div className="ocr-text">
            {current
              ? <pre>{highlight(current.text || '（此页未识别到文字）')}</pre>
              : <p className="muted">识别结果会显示在这里</p>}
          </div>
        </div>

        <div className="modal-foot">
          <span className="muted small">高精度中文模型 + 版面重排，全部资源随应用打包，无需联网或安装系统软件</span>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
