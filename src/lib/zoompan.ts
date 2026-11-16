export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 10;

export interface Pan {
  x: number;
  y: number;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * 以 viewport 内某锚点（像素坐标）为不动点缩放。
 * 返回新的 zoom 与 pan，使锚点对应的内容点在缩放前后屏幕位置不变。
 * 推导：内容点局部坐标 c = (anchor - pan) / zoom；
 *       新 pan' = anchor - c * newZoom = anchor - (anchor - pan) * (newZoom / zoom)。
 */
export function zoomAtPoint(
  zoom: number,
  pan: Pan,
  factor: number,
  anchorX: number,
  anchorY: number,
): { zoom: number; pan: Pan } {
  const nz = clampZoom(zoom * factor);
  const f = nz / zoom;
  return {
    zoom: nz,
    pan: {
      x: anchorX - (anchorX - pan.x) * f,
      y: anchorY - (anchorY - pan.y) * f,
    },
  };
}

/** 计算让内容完整适配 viewport 并居中显示时的 zoom 与 pan */
export function fitCenter(
  contentW: number,
  contentH: number,
  vpW: number,
  vpH: number,
): { zoom: number; pan: Pan } {
  const zoom = clampZoom(Math.min(vpW / contentW, vpH / contentH));
  return {
    zoom,
    pan: {
      x: (vpW - contentW * zoom) / 2,
      y: (vpH - contentH * zoom) / 2,
    },
  };
}
