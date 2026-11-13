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

import { readFileSync, readdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCanvas, loadImage, ImageData } from "@napi-rs/canvas";
import { createWorker, PSM } from "tesseract.js";
import { transform, build } from "esbuild";
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
  line: PSM.SINGLE_LINE,
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

// 有相对导入的模块需要 bundle 成单文件再加载
async function loadBundled(entry) {
  const { outputFiles } = await build({
    entryPoints: [path.join(REPO, "src", "lib", entry)],
    bundle: true,
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const code = outputFiles[0].text;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const loadDetect = () => loadBundled("idcard-detect.ts");
const loadAdaptive = () => loadBundled("ocr-adaptive.ts");

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

/** app 同款证件定位：analyzePixels 找卡片矩形并裁剪，模拟真实用户路径 */
async function detectCardCrop(img, detect) {
  const a = detect.analyzePixels({
    width: img.width,
    height: img.height,
    data: img.rgba,
  });
  const located = a.fit >= 0.22 && a.quality >= 0.2;
  // 定位失败时 analyzePixels 的 rect 会退化成极小裁切（合并正反面 / 纹理背景常见），
  // 再叠加预处理的自动放大就会把正文切没。此时必须退回整图，不做任何裁剪。
  if (!located) {
    return {
      ...img,
      located: false,
      fit: a.fit,
      quality: a.quality,
    };
  }
  // 未定位成功（fit 差）时 analyzePixels 的 rect 已退化为最小裁切，直接沿用
  const x0 = Math.round(a.rect.x * img.width);
  const y0 = Math.round(a.rect.y * img.height);
  const w = Math.max(8, Math.round(a.rect.w * img.width));
  const h = Math.max(8, Math.round(a.rect.h * img.height));
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(
    (() => {
      const src = createCanvas(img.width, img.height);
      src.getContext("2d").putImageData(new ImageData(img.rgba, img.width, img.height), 0, 0);
      return src;
    })(),
    x0, y0, w, h, 0, 0, w, h,
  );
  const { data } = ctx.getImageData(0, 0, w, h);
  return {
    rgba: data,
    width: w,
    height: h,
    located,
    fit: a.fit,
    quality: a.quality,
  };
}

async function loadPdfPage(filePath, dpi) {
  // macOS：pdfjs 的 page.render 与 @napi-rs/canvas 在 Node 22 下会触发原生段错误
  // （退出码 139，连 catch 都来不及）。改用系统自带的 sips 离线栅格化，
  // 先取 72dpi 基准宽度，再按目标 DPI 重采样，保持与原 pdfjs 路径同尺度。
  if (process.platform === "darwin") {
    const probe = path.join(os.tmpdir(), `ocr-eval-probe-${process.pid}.png`);
    const out = path.join(os.tmpdir(), `ocr-eval-page-${process.pid}.png`);
    try {
      execFileSync("sips", ["-s", "format", "png", filePath, "--out", probe],
        { stdio: "ignore" });
      const base = await loadImage(probe);
      const targetW = Math.max(1, Math.round(base.width * dpi / 72));
      execFileSync("sips", ["-s", "format", "png", "--resampleWidth", String(targetW),
        filePath, "--out", out], { stdio: "ignore" });
      const result = await loadImageData(out);
      return result;
    } catch (e) {
      console.warn(`[PDF] sips 栅格化失败，回退 pdfjs：${e.message}`);
    } finally {
      for (const f of [probe, out]) {
        try { unlinkSync(f); } catch { /* 临时文件可能不存在 */ }
      }
    }
  }
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
    // @napi-rs/canvas 改 width/height 会让原 context 失效；必须重取，
    // 否则 pdfjs 复用该 context 时会触发原生段错误（退出码 139）。
    reset: (obj, cw, ch) => {
      if (obj.canvas.width !== cw || obj.canvas.height !== ch) {
        obj.canvas.width = cw;
        obj.canvas.height = ch;
      }
      obj.context = obj.canvas.getContext("2d");
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

/**
 * 多候选自适应识别。inputs[0] 为整图（基线），后续为可选的证件定位裁剪图。
 * auto 模式下枚举「输入 × 预处理模式」少量候选，用共享打分函数选优；
 * 显式指定 preprocess 时退化为单次识别，保证已有对照实验口径不变。
 */
async function recognize(inputs, settings, prep, correct, adaptive) {
  const worker = await getWorker(settings.lang || "chi+eng");
  const langEng = (settings.lang || "chi+eng") === "eng";
  const mode = settings.preprocess || "auto";
  const basePsm = settings.psm || "block";
  const candidates = [];
  const variants = [];

  for (const inp of inputs) {
    const gray = prep.rgbaToGray(inp.rgba, inp.width, inp.height);
    // 先算一次 auto 的 applied，用于去掉与启发式重复的显式候选（省一次 OCR）
    const autoProbe = prep.preprocessGray(gray, "auto", {});
    // 「原图 none」必须留在候选里：斜向阴影 / 光照渐变会让 Sauvola 二值化
    // 把暗区文字整片抹掉，此时只有不做增强的原图能救回内容。
    const modes = mode !== "auto"
      ? [mode]
      : ["auto", "none", "binary", "gray"].filter(
          (m) => m === "auto" || m !== autoProbe.applied,
        );
    for (const m of modes) {
      variants.push({
        inp, m, deskew: true, psm: basePsm,
        result: m === "auto" ? autoProbe : prep.preprocessGray(gray, m, {}),
      });
    }
    if (mode === "auto") {
      // 不纠偏兜底：投影法估角在渐变 / 纹理背景上可能误判，旋转会毁掉正文
      variants.push({
        inp, m: "none", deskew: false, psm: basePsm,
        result: prep.preprocessGray(gray, "none", { deskew: false }),
      });
      // 版面模式维度：单栏在手机翻拍 / 纹理背景上通常比整块文字更稳
      if (basePsm !== "column") {
        variants.push({ inp, m: "auto", deskew: true, psm: "column", result: autoProbe });
      }
    }
  }

  for (const v of variants) {
    // 每次都显式重设：worker 参数跨候选 / 跨样本保留，白名单必须清空
    await worker.setParameters({
      tessedit_pageseg_mode: PSM_MAP[v.psm],
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
      tessedit_char_whitelist: settings.whitelist ?? "",
    });
    const out = prep.grayToRgba(v.result.image);
    const c = createCanvas(v.result.image.width, v.result.image.height);
    c.getContext("2d").putImageData(
      new ImageData(out, v.result.image.width, v.result.image.height), 0, 0,
    );
    const { data } = await worker.recognize(c.toBuffer("image/png"), {}, { text: true });
    const raw = prep.normalizeOcrText((data.text || "").trim());
    let finalText = correct.correctOcrText(raw);
    if (!langEng) finalText = correct.filterNoiseLines(finalText);
    candidates.push({
      text: finalText,
      raw,
      confidence: data.confidence ?? 0,
      key: `${v.inp.key}/${v.m}/${v.deskew ? "deskew" : "raw"}/${v.result.stats.upscale}x→${v.result.applied}/${v.psm}`,
      upscale: v.result.stats.upscale,
      applied: v.result.applied,
      stats: v.result.stats,
    });
  }

  const pick = candidates.length > 1
    ? adaptive.pickBestCandidate(candidates)
    : { best: candidates[0], baseline: candidates[0], switched: false, scores: [] };
  const best = pick.best;
  return {
    text: best.raw,
    corrected: best.text,
    confidence: best.confidence,
    applied: best.applied,
    candidate: best.key,
    switched: pick.switched,
    stats: best.stats,
    candidates: candidates.map((c, i) => ({
      key: c.key, conf: c.confidence, score: pick.scores[i] ?? null,
      // 保留每个候选的文本片段，便于诊断「打分选中了乱码 / 过滤层清空了内容」
      raw: c.raw.slice(0, 160), text: c.text.slice(0, 160),
    })),
  };
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
  const detect = await loadDetect();
  const adaptive = await loadAdaptive();
  const manifestPath = path.join(SAMPLES_DIR, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    console.error(`无法读取 manifest.json：${e.message}`);
    process.exit(1);
  }

  // --only <正则>：只评测 id 匹配的样本，用于快速回归单个/一组样本
  const onlyIdx = process.argv.indexOf("--only");
  const onlyArg = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  if (onlyArg) {
    const re = new RegExp(onlyArg);
    manifest = manifest.filter((s) => re.test(s.id));
    console.log(`[过滤] 仅评测 ${manifest.length} 个样本：${manifest.map((s) => s.id).join(", ")}\n`);
  }

  const rows = [];
  let totalEdits = 0;
  let totalRef = 0;

  for (const s of manifest) {
    const file = path.join(SAMPLES_DIR, s.file);
    process.stdout.write(`识别中：${s.id} ... `);
    try {
      const full = await loadImageData(file, s.dpi || DEFAULT_DPI);
      const inputs = [{ key: "full", ...full }];
      let detectInfo = "";
      if (s.detect === "card") {
        const det = await detectCardCrop(full, detect);
        detectInfo = ` [定位${det.located ? "✓" : "✗"} fit=${det.fit.toFixed(2)}]`;
        // 定位成功才把裁剪图作为额外候选；失败时 rect 已退化，整图是唯一可信输入
        if (det.located) {
          inputs.push({ key: "crop", rgba: det.rgba, width: det.width, height: det.height });
        }
      }
      const res = await recognize(inputs, s, prep, correct, adaptive);
      const { text, corrected, confidence, applied, stats } = res;
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
        candidate: res.candidate,
        switched: res.switched,
        candidates: res.candidates,
        refLen: r.refLen,
        text,
        textAfter: corrected,
        ref,
      });
      const d = ((r.cer - r2.cer) * 100).toFixed(2);
      console.log(
        `CER=${(r2.cer * 100).toFixed(2)}%（纠错前 ${(r.cer * 100).toFixed(2)}%，Δ${r2.cer < r.cer ? "-" : "+"}${d}pp）  置信=${confidence.toFixed(0)}%  [${applied}${stats.upscale > 1 ? ` ${stats.upscale}x` : ""}]` +
        `${res.switched ? ` (自适应→${res.candidate})` : ""}${detectInfo}`,
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
  // 过滤模式写到单独文件，避免覆盖完整基线
  const outName = onlyArg ? "last-result-only.json" : "last-result.json";
  fs.writeFileSync(
    path.join(__dirname, outName),
    JSON.stringify(out, null, 2),
    "utf8",
  );
  console.log(`结果已写入 scripts/eval-ocr/${outName}`);

  // Tesseract worker 会一直占用事件循环；不显式 terminate，结果写完进程也不退出，
  // 表现为「评测跑了一小时还没结束」。必须在 main 末尾统一回收。
  for (const pending of workerCache.values()) {
    try { (await pending).terminate(); } catch { /* 已终止则忽略 */ }
  }
  workerCache.clear();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
