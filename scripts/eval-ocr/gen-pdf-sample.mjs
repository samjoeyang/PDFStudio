// 生成「图片型 PDF」样本：用 @napi-rs/canvas 把文字渲染成位图，再用 pdf-lib 嵌进 PDF。
// 这模拟用户的真实输入（扫描件/图片型 PDF），pdfjs 只需解码内嵌位图，
// 不会触发矢量字体的字形解码问题。用于验证 pdfjs → 栅格化 → 预处理 → OCR 链路。
import { PDFDocument } from "pdf-lib";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT = path.resolve(__dirname, "..", "..", "public", "ocr", "fonts", "NotoSansCJKsc-Regular.otf");
const OUT = path.join(__dirname, "samples", "doc-sample.pdf");
const TEXT =
  "PDF Studio 是一个本地优先的桌面 PDF 工作台。\n" +
  "它支持合并、批注、水印、文字提取与 OCR、身份证排版等功能。\n" +
  "所有处理都在本机完成，完全离线，不会上传任何服务器。";

GlobalFonts.registerFromPath(FONT, "Noto");
const W = 1190;
const H = 1684;
const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#ffffff";
ctx.fillRect(0, 0, W, H);
ctx.fillStyle = "#000000";
ctx.font = "36px Noto";
const lines = TEXT.split("\n");
let y = 120;
for (const line of lines) {
  ctx.fillText(line, 120, y);
  y += 60;
}
const png = canvas.toBuffer("image/png");

const doc = await PDFDocument.create();
const img = await doc.embedPng(png);
const page = doc.addPage([595, 842]);
page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
writeFileSync(OUT, await doc.save());
writeFileSync(path.join(__dirname, "samples", "doc-sample.ref.txt"), TEXT);
console.log("wrote samples/doc-sample.pdf (image-based)");
