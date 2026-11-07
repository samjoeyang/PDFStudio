// 读取指定 Release 的资产，生成 docs/latest.json（官网下载区消费的版本快照）。
// 用法: node scripts/gen-latest.mjs <tag>  例: node scripts/gen-latest.mjs v0.1.0
// 依赖环境变量 GITHUB_REPOSITORY 与 GH_TOKEN（GitHub Actions 中自动提供）。
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const tag = process.argv[2];
if (!tag) {
  console.error('用法: node scripts/gen-latest.mjs <tag>');
  process.exit(1);
}

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) {
  console.error('缺少环境变量 GITHUB_REPOSITORY');
  process.exit(1);
}

// 通过 gh 拉取 release 信息（自动携带 GH_TOKEN 鉴权）
const api = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
let rel;
try {
  rel = JSON.parse(execSync(`gh api ${api}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
} catch (e) {
  console.error(`获取 release ${tag} 失败: ${e.message}`);
  process.exit(1);
}

const assets = rel.assets || [];

// 平台 -> 主包 / 备选包 的扩展名优先级（与 rename-assets.mjs 产出的文件名对应）
const map = {
  'macos-apple': { primary: ['.dmg'], alt: ['.app.tar.gz'] },
  'macos-intel': { primary: ['.dmg'], alt: ['.app.tar.gz'] },
  'windows-x64': { primary: ['.msi'], alt: ['.exe'] },
  'windows-x86': { primary: ['.msi'], alt: ['.exe'] },
  'linux-x86_64': { primary: ['.AppImage'], alt: ['.deb', '.rpm'] },
};

const altLabel = (name) => {
  const n = name.toLowerCase();
  if (n.endsWith('.exe')) return '便携版 (.exe)';
  if (n.endsWith('.app.tar.gz') || n.endsWith('.tar.gz')) return '免安装版 (.tar.gz)';
  if (n.endsWith('.deb')) return 'Debian (.deb)';
  if (n.endsWith('.rpm')) return 'RPM (.rpm)';
  if (n.endsWith('.appimage')) return 'AppImage (免安装)';
  return '';
};

const out = {
  version: (rel.tag_name || tag).replace(/^v/, ''),
  tag: rel.tag_name || tag,
  publishedAt: rel.published_at || null,
  notes: rel.body || '',
  assets: {},
};

for (const [plat, cfg] of Object.entries(map)) {
  const found = assets.filter((a) => a.name.includes(plat));
  if (!found.length) continue;
  const pick = (exts) => found.find((a) => exts.some((e) => a.name.toLowerCase().endsWith(e.toLowerCase())));
  const primary = pick(cfg.primary) || found[0];
  const alt = pick(cfg.alt);
  out.assets[plat] = {
    url: primary.browser_download_url,
    size: primary.size,
    altUrl: alt ? alt.browser_download_url : null,
    altLabel: alt ? altLabel(alt.name) : '',
  };
}

writeFileSync('docs/latest.json', JSON.stringify(out, null, 2) + '\n');
console.log(`已生成 docs/latest.json (version=${out.version}, 平台: ${Object.keys(out.assets).join(', ') || '无'})`);
