# OCR 基线评测（CER）

用项目**真实的预处理逻辑 + 离线 Tesseract 引擎**跑样本，算出 **CER（字符错误率）**，
作为后续任何 OCR 优化的量化基线。没有这一步，调参都是盲调。

- CER = (替换 + 删除 + 插入) / 参考字符数，越低越好。
- 字符准确率 = 1 − CER（中文默认忽略空格后计算，更公平）。
- 引擎、tessdata、字体都与 app 同源、完全离线。

## 运行

```bash
npm run eval:ocr            # 跑评测，输出逐样本 + 汇总，并写 last-result.json
npm run eval:ocr:gen        # 重新生成合成样例图（含精确 ground truth）
node scripts/eval-ocr/gen-pdf-sample.mjs   # 重新生成图片型 PDF 样例
```

首次运行会加载中文模型，稍慢（约 30~60s）。

## 样本结构

- `samples/manifest.json`：评测清单，每条：
  ```json
  { "id": "cn-paragraph", "file": "cn-paragraph.png",
    "lang": "chi+eng", "preprocess": "auto", "psm": "block",
    "ref": "cn-paragraph.ref.txt" }
  ```
  - `file`：样本文件，支持 PNG / JPG / PDF（PDF 取第 1 页栅格化）。
  - `lang`：`chi+eng` | `chi` | `eng`
  - `preprocess`：`auto` | `gray` | `binary` | `none`
  - `psm`：`block` | `column` | `auto` | `sparse`
  - `ref`：参考文本。可以是同目录的 `.ref.txt` 文件名，或直接写内联字符串。
  - `dpi`（可选）：仅 PDF 用，默认 350。

## 如何加入你自己的真实样本（关键）

当前 `samples/` 里是**干净渲染**的合成样本，仅供打通链路、建立天花板基线。
真正有压力的是你的**扫描件 / 拍照件**。请：

1. 把真实 PDF / 图片放进 `samples/`；
2. 准备对应 ground truth：新建 `<id>.ref.txt` 写入准确文本，
   或在 manifest 里用 `ref: "这里是准确文本"` 内联；
3. 在 `manifest.json` 追加一条；
4. 重新 `npm run eval:ocr`。

建议覆盖：模糊图、阴影翻拍、倾斜页、表格、手写、小字号。
样本越多、越贴近真实分布，基线越可信。

## 输出示例

```
样本                   CER       字符准确率       置信度
cn-paragraph       4.88%      95.12%    84.00%
cn-en-mixed        1.37%      98.63%    91.00%
id-form            1.12%      98.88%    89.00%
doc-sample         7.32%      92.68%    82.00%
------------------------------------------------------------
整体(字数加权)           3.68%      96.32%
```

`置信度` 是 Tesseract 自报的置信，与 CER 是两个独立视角，一起看。

## 实现要点

- `run.mjs` 在运行时用 esbuild 把 `src/lib/preprocess.ts` 编译进来，
  保证评测用的是**线上同款**预处理逻辑，不会脱节。
- 图像解码 / PDF 栅格化用 `@napi-rs/canvas` + `pdfjs-dist`，与浏览器端逻辑一致。
- 结果同时写入 `last-result.json`，方便前后对比（回归）。
