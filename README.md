# PDF Studio

> 本地优先的桌面 PDF 工作台 —— 合并、批注、水印、文字提取与 OCR、身份证排版、压缩优化，全部在本机完成，离线可用。

[![GitHub release](https://img.shields.io/github/v/release/samjoeyang/PDFStudio?label=Release)](https://github.com/samjoeyang/PDFStudio/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)](https://samjoeyang.github.io/PDFStudio/)
[![License](https://img.shields.io/github/license/samjoeyang/PDFStudio)](LICENSE)
[![官网](https://img.shields.io/badge/site-samjoeyang.github.io%2FPDFStudio-green)](https://samjoeyang.github.io/PDFStudio/)

---

## ✨ 功能特性

- **合并 / 重排 / 拆分 / 旋转**：多 PDF 拖入工作区，网格顺序即导出顺序；框选、Shift 连选、拖拽排序、整页旋转与删除。
- **批注与签名**：双击页面添加批注、手绘签名与标记，按页保存并叠加到导出 PDF。
- **水印**：文字 / 图片水印，支持全部页或仅选中页，带实时预览。
- **文字提取与 OCR**：内置 tesseract.js 与中英文语言包，**完全离线**识别扫描件 / 图片为可搜索文字层。
- **身份证排版**：一键把身份证正反面排版为标准 A4 扫描件 PDF，自动检测版式。
- **压缩与体积优化**：图像重编码压缩（可调 DPI 与 JPEG 质量）；另提供对象流与元数据清理。
- **撤销 / 重做**：完整历史栈，Ctrl / ⌘ + Z 撤销、Shift 连按重做。
- **隐私优先**：纯本地运行，文档不上传任何服务器，断网照常工作。

---

## 📥 下载

最新安装包通过 GitHub Releases 分发，推荐前往 **[官网下载页](https://samjoeyang.github.io/PDFStudio/#download)** 按系统一键获取：

| 平台 | 架构 | 格式 |
| --- | --- | --- |
| macOS | Apple 芯片 (M1/M2/M3…) | `.dmg` |
| macOS | Intel 芯片 | `.dmg` |
| Windows | 64 位 | `.msi` / `.exe` 便携版 |
| Windows | 32 位 | `.msi` / `.exe` 便携版 |
| Linux | 64 位 | `.AppImage` / `.deb` |

> 所有历史版本见 [Releases](https://github.com/samjoeyang/PDFStudio/releases)。

---

## 🚀 安装与使用

1. 下载对应系统安装包（见上表或官网）。
2. 安装 / 解压后启动应用。
3. 把 PDF 拖入主窗口，或点击「打开 PDF」。
4. 在页面网格中重排、旋转、删除，或打开批注 / 水印 / OCR / 身份证排版面板。
5. 点击「导出全部」或「导出选中」生成最终 PDF。

**常用技巧**
- 页面网格顺序 = 导出顺序；仅导出选中页即可拆分 / 提取。
- 双击页面卡片添加批注与签名；`Delete` 删除选中页。
- 导出时开启「优化体积」与「图像重编码压缩」可显著减小文件。

---

## 🛠 本地开发构建

### 环境要求
- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://www.rust-lang.org/) 稳定版（含对应平台目标）
- 系统依赖（Linux）：`libwebkit2gtk-4.1-dev`、`libappindicator3-dev`、`librsvg2-dev`、`patchelf` 等

### 步骤
```bash
# 1. 安装前端依赖
npm install

# 2. 启动开发模式（Vite + Tauri 窗口）
npm run tauri dev

# 3. 打包生产安装包（产物在 src-tauri/target/release/bundle/）
npm run tauri build
```

技术栈：Tauri v2 · React 18 · Vite 6 · TypeScript · pdf-lib · pdfjs-dist · tesseract.js。

---

## 🤖 自动构建与发布

仓库内置 GitHub Actions，推送版本 tag 即可全自动构建并发布：

- **`.github/workflows/build.yml`** —— 通过 matrix 在 macOS / Windows / Ubuntu 上分别构建：
  - macOS：**Apple 芯片** (`aarch64-apple-darwin`) 与 **Intel** (`x86_64-apple-darwin`)
  - Windows：**64 位** (`x86_64-pc-windows-msvc`) 与 **32 位** (`i686-pc-windows-msvc`)
  - Linux：**64 位** (`x86_64-unknown-linux-gnu`)
  - 构建完成后聚合创建 GitHub Release 并上传全部安装包。
- **`.github/workflows/publish-site.yml`** —— 新版本 Release 发布后，生成 `docs/latest.json`（版本与各平台下载链接快照）并提交，官网下载区据此自动展示最新版本。

发布方式（二选一）：
```bash
# 方式一：打 tag 自动触发
git tag v0.1.0 && git push origin v0.1.0

# 方式二：在 Actions → Build & Release → Run workflow 中手动填入版本号
```

> 说明：当前工作流产出**未签名**安装包。macOS 首次打开需在「系统设置 → 隐私与安全性」中点「仍要打开」；如需消除提示，可后续在 `build.yml` 中配置 Apple 签名 / 公证密钥（ Secrets ）。

---

## 🌐 官网

项目官网基于 GitHub Pages，源码即本仓库 `docs/` 目录：
👉 **https://samjoeyang.github.io/PDFStudio/**

包含软件介绍、安装使用、下载地址、讨论组与赞助入口。官网内容由 `docs/` 目录构建并自动发布到独立的 `gh-pages` 分支（根目录）托管，无需手动配置：

- **`.github/workflows/deploy.yml`** —— 推送 `main` 且 `docs/` 有改动时，自动把 `docs/` 内容部署到 `gh-pages` 分支（GitHub Pages 源已设为 `gh-pages`）。
- 发布新版本后，`publish-site.yml` 会更新 `docs/latest.json` 并推回 `main`，随即触发本工作流刷新官网下载入口。

如需手动重部署官网：`Actions → Deploy Site → Run workflow`。

---

## 💬 讨论组

- 💬 [GitHub Discussions](https://github.com/samjoeyang/PDFStudio/discussions) —— 提问与建议
- 🐞 [Issues](https://github.com/samjoeyang/PDFStudio/issues) —— 上报 Bug / 功能请求
- ⭐ [项目仓库](https://github.com/samjoeyang/PDFStudio)

---

## ☕ 赞助

如果这个工具帮到了你，欢迎支持持续开发：
- ❤️ [GitHub Sponsors](https://github.com/sponsors/samjoeyang)
- 🧧 爱发电（链接待补充）

---

## 📄 许可证

参见 [LICENSE](LICENSE)。
