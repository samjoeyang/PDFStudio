// 将发布版本号写入 Tauri 配置与 Cargo，使打出的安装包版本与 Git tag 一致。
// 用法: node scripts/set-version.mjs <version>  例: node scripts/set-version.mjs 0.1.0
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
  console.error('用法: node scripts/set-version.mjs <version>');
  process.exit(1);
}

// 1) tauri.conf.json
const confPath = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(readFileSync(confPath, 'utf8'));
conf.version = version;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n');

// 2) Cargo.toml —— 仅替换 [package] 下的 version（行首锚定，避免误伤依赖里的 version）
const cargoPath = 'src-tauri/Cargo.toml';
const cargo = readFileSync(cargoPath, 'utf8');
const updated = cargo.replace(/^version = ".*"/m, `version = "${version}"`);
writeFileSync(cargoPath, updated);

console.log(`已将版本号设置为 ${version}`);
