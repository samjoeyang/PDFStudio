/**
 * vite build 只转译它自己打进 chunk 的代码；通过 `?url` 引入的
 * pdf.worker.min.mjs 是原样复制的静态资源，仍带 ES2022 类静态块，
 * 在 macOS 12 的 WKWebView (WebKit 17613) 里会直接解析失败。
 * 这里在构建后统一降级到 ES2020，并补上 worker 独立作用域所需的
 * Promise.withResolvers（主页面的 polyfill 在 index.html，两者不共享全局）。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transform } from 'esbuild';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');

const POLYFILL = `if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function () {
    var resolve, reject;
    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    return { promise: promise, resolve: resolve, reject: reject };
  };
}
`;

const files = (await readdir(assetsDir)).filter((f) => /^pdf\.worker.*\.mjs$/.test(f));
if (files.length === 0) throw new Error('[patch-worker] dist/assets 下未找到 pdf.worker*.mjs');

for (const file of files) {
  const path = join(assetsDir, file);
  const source = await readFile(path, 'utf8');
  const { code } = await transform(source, {
    loader: 'js',
    target: 'es2020',
    format: 'esm',
    sourcefile: file,
    legalComments: 'inline',
  });
  await writeFile(path, POLYFILL + code, 'utf8');
  console.log(`[patch-worker] ${file}: ES2020 降级 + Promise.withResolvers polyfill`);
}
