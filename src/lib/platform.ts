import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';

export function isTauri(): boolean {
  return typeof window !== 'undefined'
    && ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 桌面端走系统保存对话框，浏览器开发模式降级为下载 */
export async function saveFile(
  name: string,
  bytes: Uint8Array,
  mime: string,
  extensions: string[],
): Promise<boolean> {
  if (isTauri()) {
    const path = await save({
      defaultPath: name,
      filters: [{ name: `${extensions[0].toUpperCase()} 文件`, extensions }],
    });
    if (!path) return false;
    await invoke('write_file_b64', { path, data: toBase64(bytes) });
    return true;
  }

  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(new Blob([buffer], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return true;
}

export const savePdf = (name: string, bytes: Uint8Array) =>
  saveFile(name, bytes, 'application/pdf', ['pdf']);

export const saveText = (name: string, bytes: Uint8Array) =>
  saveFile(name, bytes, 'text/plain;charset=utf-8', ['txt']);

/** 文件关联 / 单实例启动时，从 Rust 侧读取磁盘上的 PDF */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  return fromBase64(await invoke<string>('read_file_b64', { path }));
}

export function onOpenFiles(handler: (paths: string[]) => void): () => void {
  if (!isTauri()) return () => undefined;
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void listen<string[]>('open-files', (e) => { if (!cancelled) handler(e.payload); })
    .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
  return () => { cancelled = true; unlisten?.(); };
}
