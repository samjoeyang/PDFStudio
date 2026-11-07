// OCR 评测运行器（Node）。
//
// 做法：复用项目真实的预处理逻辑（src/lib/preprocess.ts，运行时用 esbuild 编译）
// + 离线 Tesseract 引擎（与 app 同源的 tessdata），对每个样本跑 OCR，
// 再与 ground truth 算 CER（字符错误率）与字符准确率。
//
// 支持两类样本：
//   - 图片（PNG/JPG）：用 @napi-rs/canvas 解码
//   - PDF（扫描件/图片型）：用 pdfjs-dist 渲染第 1 页（同 app 的栅格化逻辑）
//
// 运行：node scripts/eval-ocr/run.mjs
//   （可选）npm run eval:ocr:gen  重新生成合成样例

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas, loadImage, ImageData } from "@napi-rs/canvas";
import { createWorker, PSM } from "tesseract.js";
import { transform } from "esbuild";
import { cer } from "./lib-cer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const SAMPLES_DIR = path.join(__dirname, "samples");
const TESSDATA = path.join(REPO, "public", "ocr", "tessdata");
const MAX_CANVAS_AREA = 26_000_000;
const DEFAULT_DPI = 350;

const LANGS = {
  "chi+eng": ["chi_sim", "eng"],
  chi: ["chi_sim"],
  eng: ["eng"],
};
const PSM_MAP = {
  block: PSM.SINGLE_BLOCK,
  auto: PSM.AUTO,
  column: PSM.SINGLE_COLUMN,
  sparse: PSM.SPARSE_TEXT,
};

// ---- 编译项目里的 preprocess.ts / ocr-correct.ts，保持与线上一致 ----
async function loadPreprocess() {
  const src = readFileSync(path.join(REPO, "src", "lib", "preprocess.ts"), "utf8");
  const { code } = await transform(src, { loader: "ts", format: "esm" });
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

async function loadCorrect() {
  const src = readFileSync(path.join(REPO, "src", "lib", "ocr-correct.ts"), "utf8");
  const { code } = await transform(src, { loader: "ts", format: "esm" });
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

// ---- 样本加载：图片或 PDF ----
async function loadImageData(filePath, dpi = DEFAULT_DPI) {
  if (filePath.toLowerCase().endsWith(".pdf")) {
    return loadPdfPage(filePath, dpi);
  }
  const img = await loadImage(filePath);
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const { data } = ctx.getImageData(0, 0, img.width, img.height);
  return { rgba: data, width: img.width, height: img.height };
}

async function loadPdfPage(filePath, dpi) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  try {
    const workerPath = path.join(
      path.dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))),
      "pdf.worker.mjs",
    );
    pdfjs.GlobalWorkerOptions.workerSrc = workerPath;
  } catch {
    /* 主线程回退 */
  }
  const bytes = readFileSync(filePath);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const page = await doc.getPage(1);
  const natural = page.getViewport({ scale: 1 });
  const area = Math.max(1, natural.width * natural.height);
  const scale = Math.min(dpi / 72, Math.sqrt(MAX_CANVAS_AREA / area));
  const vp = page.getViewport({ scale });
  const w = Math.ceil(vp.width);
  const h = Math.ceil(vp.height);
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  const canvasFactory = {
    create: (cw, ch) => {
      const cc = createCanvas(cw, ch);
      return { canvas: cc, context: cc.getContext("2d") };
    },
    reset: (obj, cw, ch) => {
      obj.canvas.width = cw;
      obj.canvas.height = ch;
    },
    destroy: () => {},
  };
  await page.render({ canvasContext: ctx, viewport: vp, canvasFactory }).promise;
  await doc.destroy();
  const { data } = ctx.getImageData(0, 0, w, h);
  return { rgba: data, width: w, height: h };
}

// ---- 单样本识别 ----
const workerCache = new Map();
async function getWorker(langKey) {
  if (!workerCache.has(langKey)) {
    const langs = LANGS[langKey] || LANGS["chi+eng"];
    workerCache.set(
      langKey,
      createWorker(langs, 1, {
        langPath: TESSDATA,
        gzip: true,
        cacheMethod: "none",
      }),
    );
  }
  return workerCache.get(langKey);
}

async function recognize({ rgba, width, height }, settings, prep) {
  const gray = prep.rgbaToGray(rgba, width, height);
  const result = prep.preprocessGray(gray, settings.preprocess || "auto", {});
  const out = prep.grayToRgba(result.image);
  const c = createCanvas(result.image.width, result.image.height);
  c.getContext("2d").putImageData(
    new ImageData(out, result.image.width, result.image.height),
    0,
    0,
  );
  const buffer = c.toBuffer("image/png");

  const worker = await getWorker(settings.lang || "chi+eng");
  await worker.setParameters({
    tessedit_pageseg_mode: PSM_MAP[settings.psm || "block"],
    preserve_interword_spaces: "1",
    user_defined_dpi: "300",
  });
  const { data } = await worker.recognize(buffer, {}, { text: true });
  const text = prep.normalizeOcrText((data.text || "").trim());
  return { text, confidence: data.confidence ?? 0, applied: result.applied, stats: result.stats };
}

// ---- 主流程 ----
function readReference(ref) {
  if (typeof ref === "string" && /\.(txt|ref)$/i.test(ref)) {
    return readFileSync(path.join(SAMPLES_DIR, ref), "utf8").replace(/\s+$/, "");
  }
  return String(ref ?? "");
}

async function main() {
  const prep = await loadPreprocess();
  const correct = await loadCorrect();
  const manifestPath = path.join(SAMPLES_DIR, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`无法读取 manifest.json：${e.message}`);
    process.exit(1);
  }

  const rows = [];
  let totalEdits = 0;
  let totalRef = 0;

  for (const s of manifest) {
    const file = path.join(SAMPLES_DIR, s.file);
    process.stdout.write(`识别中：${s.id} ... `);
    try {
      const img = await loadImageData(file, s.dpi || DEFAULT_DPI);
      const { text, confidence, applied, stats } = await recognize(img, s, prep);
      const corrected = correct.correctOcrText(text);
      const ref = readReference(s.ref);
      const r = cer(ref, text);
      const r2 = cer(ref, corrected);
      totalEdits += r2.edits;
      totalRef += r.refLen;
      rows.push({
        id: s.id,
        cer: r2.cer,
        charAcc: r2.charAcc,
        cerBefore: r.cer,
        charAccBefore: r.charAcc,
        conf: confidence / 100,
        prep: applied,
        up: stats.upscale,
        refLen: r.refLen,
      });
      const d = ((r.cer - r2.cer) * 100).toFixed(2);
      console.log(
        `CER=${(r2.cer * 100).toFixed(2)}%（纠错前 ${(r.cer * 100).toFixed(2)}%，Δ${r2.cer < r.cer ? "-" : "+"}${d}pp）  置信=${confidence.toFixed(0)}%  [${applied}${stats.upscale > 1 ? ` ${stats.upscale}x` : ""}]`,
      );
    } catch (e) {
      console.log(`失败：${e.message}`);
      rows.push({ id: s.id, cer: NaN, charAcc: NaN, conf: NaN, prep: "ERR", up: 1, refLen: 0 });
    }
  }

  // 汇总
  const valid = rows.filter((r) => !Number.isNaN(r.cer));
  const overallCer = totalRef ? totalEdits / totalRef : NaN;
  const meanCer = valid.length
    ? valid.reduce((a, r) => a + r.cer, 0) / valid.length
    : NaN;
  const meanAcc = valid.length
    ? valid.reduce((a, r) => a + r.charAcc, 0) / valid.length
    : NaN;

  console.log("\n" + "=".repeat(70));
  console.log("基线评测汇总（含后纠错，CER 越低越好）");
  console.log("=".repeat(70));
  const fmtPct = (x) => (Number.isNaN(x) ? "-" : (x * 100).toFixed(2) + "%");
  console.log(
    `${"样本".padEnd(14)}${"CER(前→后)".padStart(20)}${"准确率(后)".padStart(12)}${"置信度".padStart(10)}`,
  );
  for (const r of rows) {
    const beforeAfter = Number.isNaN(r.cerBefore)
      ? "-"
      : `${(r.cerBefore * 100).toFixed(2)}% → ${(r.cer * 100).toFixed(2)}%`;
    console.log(
      `${r.id.padEnd(14)}${beforeAfter.padStart(20)}${fmtPct(r.charAcc).padStart(12)}${fmtPct(r.conf).padStart(10)}`,
    );
  }
  console.log("-".repeat(60));
  console.log(
    `${"整体(字数加权)".padEnd(14)}${fmtPct(overallCer).padStart(10)}${fmtPct(1 - overallCer).padStart(12)}`,
  );
  console.log(
    `${"平均(样本等权)".padEnd(14)}${fmtPct(meanCer).padStart(10)}${fmtPct(meanAcc).padStart(12)}`,
  );
  console.log("=".repeat(60));
  console.log(
    `样本数=${rows.length}  总参考字符=${totalRef}  总编辑距离=${totalEdits}`,
  );

  // 把结果写回，方便回归对比
  const out = {
    timestamp: new Date().toISOString(),
    overallCer,
    meanCer,
    meanCharAcc: meanAcc,
    totalRef,
    totalEdits,
    rows,
  };
  const fs = await import("node:fs");
  fs.writeFileSync(
    path.join(__dirname, "last-result.json"),
    JSON.stringify(out, null, 2),
    "utf8",
  );
  console.log(`结果已写入 scripts/eval-ocr/last-result.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
