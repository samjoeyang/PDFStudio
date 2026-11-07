// 把 Tauri 各平台打出的安装包重命名为统一、可预测的文件名，便于发布与官网按名匹配。
// 用法: node scripts/rename-assets.mjs <rust-target> <version>
//   node scripts/rename-assets.mjs aarch64-apple-darwin 0.1.0
import { readdirSync, statSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const target = process.argv[2];
const version = process.argv[3];
if (!target || !version) {
  console.error('用法: node scripts/rename-assets.mjs <rust-target> <version>');
  process.exit(1);
}

// Rust target -> 平台标识（与官网 / latest.json 的 key 对应）
const platformMap = {
  'aarch64-apple-darwin': 'macos-apple',
  'x86_64-apple-darwin': 'macos-intel',
  'x86_64-pc-windows-msvc': 'windows-x64',
  'i686-pc-windows-msvc': 'windows-x86',
  'x86_64-unknown-linux-gnu': 'linux-x86_64',
};
const plat = platformMap[target];
if (!plat) {
  console.error(`未知 target: ${target}`);
  process.exit(1);
}

// 每个平台按优先级挑选主安装包 / 备选包
const extPriority = {
  'macos-apple': ['.dmg', '.app.tar.gz'],
  'macos-intel': ['.dmg', '.app.tar.gz'],
  'windows-x64': ['.msi', '.exe'],
  'windows-x86': ['.msi', '.exe'],
  'linux-x86_64': ['.AppImage', '.deb', '.rpm'],
};

const bundleDir = join('src-tauri', 'target', target, 'release', 'bundle');
const outDir = 'upload';
mkdirSync(outDir, { recursive: true });

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const files = walk(bundleDir);
if (!files.length) {
  console.error(`未在 ${bundleDir} 找到任何打包产物，构建可能失败`);
  process.exit(1);
}

let renamed = 0;
  for (const f of files) {
    const lower = f.toLowerCase();
    for (const ext of extPriority[plat]) {
      if (lower.endsWith(ext.toLowerCase())) {
      const dest = join(outDir, `PDFStudio-${version}-${plat}${ext}`);
      copyFileSync(f, dest);
      console.log(`-> ${dest}`);
      renamed++;
      break;
    }
  }
}

if (!renamed) {
  console.error('没有匹配到任何可重命名的安装包');
  process.exit(1);
}
console.log(`已重命名 ${renamed} 个文件到 ${outDir}/`);
