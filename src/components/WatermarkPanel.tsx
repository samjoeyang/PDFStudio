import { useEffect, useRef, useState } from 'react';
import { loadPdfJsDoc, renderPageToCanvas } from '../lib/thumb';
import { drawWatermark, DEFAULT_WATERMARK } from '../lib/watermark';
import type { WatermarkSettings, WatermarkKind, WatermarkScope } from '../lib/watermark';

interface PreviewSource { bytes: Uint8Array; pageIndex: number }

interface Props {
  settings: WatermarkSettings;
  onChange: (s: WatermarkSettings) => void;
  preview: PreviewSource | null;
  selectedCount: number;
  onClose: () => void;
}

const KINDS: { id: WatermarkKind; label: string }[] = [
  { id: 'text', label: '文字水印' },
  { id: 'image', label: '图片水印' },
];
const SCOPES: { id: WatermarkScope; label: string }[] = [
  { id: 'all', label: '全部页面' },
  { id: 'selected', label: '仅选中页' },
];

export default function WatermarkPanel({ settings, onChange, preview, selectedCount, onClose }: Props) {
  const baseRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  const patch = <K extends keyof WatermarkSettings>(key: K, value: WatermarkSettings[K]) =>
    onChange({ ...settings, [key]: value });

  // 底图只渲染一次，之后调参数只做「复制底图 + 叠水印」，拖动滑块不卡顿
  useEffect(() => {
    let alive = true;
    if (!preview) { setReady(false); return; }
    setError('');
    void (async () => {
      const doc = await loadPdfJsDoc(preview.bytes);
      try {
        const canvas = await renderPageToCanvas(doc, preview.pageIndex + 1, 1.1);
        if (alive) { baseRef.current = canvas; setReady(true); }
      } finally { await doc.destroy(); }
    })().catch((e) => {
      if (alive) setError(e instanceof Error ? e.message : String(e));
    });
    return () => { alive = false; };
  }, [preview]);

  useEffect(() => {
    const view = viewRef.current, base = baseRef.current;
    if (!view || !base) return;
    view.width = base.width;
    view.height = base.height;
    const ctx = view.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(base, 0, 0);
    void drawWatermark(view, settings);
  }, [settings, ready]);

  const upload = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange({ ...settings, kind: 'image', image: String(reader.result) });
    reader.readAsDataURL(file);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal modal-watermark">
        <div className="modal-head">
          <div>
            <h3>水印</h3>
            <span>文字 / 图片 · 平铺或单幅 · 导出时写入 PDF</span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">×</button>
        </div>

        <div className="wm-body">
          <div className="wm-form">
            <div className="section-title">设置</div>
            <label className="check wm-check">
              <input type="checkbox" checked={settings.enabled}
                onChange={(e) => patch('enabled', e.target.checked)} />
              <span><strong>启用水印</strong><small>关闭后导出不带任何水印</small></span>
            </label>

            <div className="btn-row wm-kinds">
              {KINDS.map((k) => (
                <button key={k.id} className={`btn btn-small${settings.kind === k.id ? ' is-active' : ''}`}
                  onClick={() => patch('kind', k.id)}>{k.label}</button>
              ))}
            </div>

            {settings.kind === 'text' ? (
              <>
                <label>水印文字
                  <input type="text" value={settings.text} placeholder="例如：机密 · 仅供内部使用"
                    onChange={(e) => patch('text', e.target.value)} />
                </label>
                <label>字号 <b>{settings.fontSize}</b>
                  <input type="range" min="16" max="80" step="2" value={settings.fontSize}
                    onChange={(e) => patch('fontSize', Number(e.target.value))} />
                </label>
                <label>颜色
                  <input type="color" value={settings.color}
                    onChange={(e) => patch('color', e.target.value)} />
                </label>
              </>
            ) : (
              <>
                <div className="btn-row">
                  <button className="btn btn-small" onClick={() => fileRef.current?.click()}>上传图片</button>
                  {settings.image && <span className="sig-ready">图片已就绪</span>}
                </div>
                <input ref={fileRef} type="file" accept="image/*" hidden
                  onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
                <label>宽度占页宽 <b>{Math.round(settings.scale * 100)}%</b>
                  <input type="range" min="0.08" max="0.8" step="0.02" value={settings.scale}
                    onChange={(e) => patch('scale', Number(e.target.value))} />
                </label>
              </>
            )}

            <label>不透明度 <b>{Math.round(settings.opacity * 100)}%</b>
              <input type="range" min="0.05" max="1" step="0.01" value={settings.opacity}
                onChange={(e) => patch('opacity', Number(e.target.value))} />
            </label>
            <label>旋转 <b>{settings.rotation}°</b>
              <input type="range" min="-90" max="90" step="1" value={settings.rotation}
                onChange={(e) => patch('rotation', Number(e.target.value))} />
            </label>
            <label className="check wm-check">
              <input type="checkbox" checked={settings.tiled}
                onChange={(e) => patch('tiled', e.target.checked)} />
              <span><strong>平铺全页</strong><small>关闭则只在页面正中央放一个</small></span>
            </label>
            {settings.tiled && (
              <label>间距 <b>{settings.gap.toFixed(1)}×</b>
                <input type="range" min="1" max="3" step="0.1" value={settings.gap}
                  onChange={(e) => patch('gap', Number(e.target.value))} />
              </label>
            )}
            <label>作用范围
              <select value={settings.scope}
                onChange={(e) => patch('scope', e.target.value as WatermarkScope)}>
                {SCOPES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              {settings.scope === 'selected' &&
                <small>当前已选中 {selectedCount} 页；导出选中页时只作用于仍被选中的页</small>}
            </label>

            <div className="btn-row">
              <button className="btn btn-small"
                onClick={() => onChange({ ...DEFAULT_WATERMARK, enabled: settings.enabled })}>恢复默认</button>
              {settings.image &&
                <button className="btn btn-small" onClick={() => patch('image', undefined)}>清除图片</button>}
            </div>
          </div>

          <div className="wm-preview-wrap">
            <div className="section-title">效果预览 <span className="muted small">· 第 1 页 · 与导出一致</span></div>
            <div className="wm-preview">
              {ready
                ? <canvas ref={viewRef} />
                : <p className="muted small">{error || (preview ? '正在渲染预览…' : '导入 PDF 后可预览效果')}</p>}
            </div>
            <p className="muted small wm-note">
              水印在导出时烘焙进页面：带水印的页会转为高清图像，文字层不再保留；
              工作区内的文字提取 / OCR 仍读原始内容。压缩模式与批注会在同一次栅格化里一起处理。
            </p>
          </div>
        </div>

        <div className="modal-foot">
          <span className="muted small">设置即时保存，重新导出后才会出现在 PDF 里</span>
          <div className="btn-row"><button className="btn btn-primary" onClick={onClose}>完成</button></div>
        </div>
      </div>
    </div>
  );
}
