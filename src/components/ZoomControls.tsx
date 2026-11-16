interface Props {
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}

/** 右下角浮层缩放控件：缩小 / 百分比（点击适应）/ 放大 / 适应 */
export default function ZoomControls({ zoom, onZoomIn, onZoomOut, onFit }: Props) {
  return (
    <div className="zoom-controls">
      <button type="button" className="zoom-btn" onClick={onZoomOut} aria-label="缩小" disabled={zoom <= 0.11}>−</button>
      <button type="button" className="zoom-level" onClick={onFit} title="点击适应窗口">{Math.round(zoom * 100)}%</button>
      <button type="button" className="zoom-btn" onClick={onZoomIn} aria-label="放大" disabled={zoom >= 9.99}>+</button>
      <button type="button" className="zoom-fit" onClick={onFit}>适应</button>
    </div>
  );
}
