#!/usr/bin/env python3
"""
生成 OCR 评测样例：用项目自带的 Noto CJK 字体把已知文本渲染成 PNG，
ground truth 同时写成 <id>.ref.txt，供 scripts/eval-ocr/run.mjs 计算 CER。

这些样例是「干净渲染」的，仅用于打通评测链路、建立基线。
真实扫描件/拍照件才是压力测试，请把它们放进 samples/ 并追加到 manifest.json。
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(ROOT, "samples")
FONT = os.path.join(ROOT, "..", "..", "public", "ocr", "fonts", "NotoSansCJKsc-Regular.otf")
FONT = os.path.abspath(FONT)
PAD = 48

# id -> (展示文本, 字号)
SAMPLES = {
    "cn-paragraph": (
        "PDF Studio 是一个本地优先的桌面 PDF 工作台。\n"
        "它支持合并、批注、水印、文字提取与 OCR、身份证排版等功能。\n"
        "所有处理都在本机完成，完全离线，不会上传任何服务器。",
        40,
    ),
    "cn-en-mixed": (
        "订单编号：20240101-8842\n"
        "客户姓名：张三\n"
        "联系电话：138-0013-8000\n"
        "应付金额：￥1,288.00\n"
        "备注：请在三个工作日内确认收货。",
        40,
    ),
    "id-form": (
        "姓名：李四  性别：男  出生：1990-05-12\n"
        "证件号：11010119900512371X\n"
        "地址：北京市朝阳区建国路 88 号\n"
        "签发机关：北京市公安局  有效期：2015.01-2035.01",
        36,
    ),
}


def render(text: str, size: int, path: str):
    font = ImageFont.truetype(FONT, size)
    lines = text.split("\n")
    line_h = int(size * 1.5)
    # 计算最大行宽
    max_w = max(font.getlength(line) for line in lines)
    w = int(max_w) + PAD * 2
    h = line_h * len(lines) + PAD * 2
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    y = PAD
    for line in lines:
        d.text((PAD, y), line, fill="black", font=font)
        y += line_h
    img.save(path, "PNG")
    print(f"  wrote {os.path.relpath(path, ROOT)}  ({w}x{h})")


def main():
    os.makedirs(OUT, exist_ok=True)
    for sid, (text, size) in SAMPLES.items():
        png = os.path.join(OUT, sid + ".png")
        ref = os.path.join(OUT, sid + ".ref.txt")
        render(text, size, png)
        with open(ref, "w", encoding="utf-8") as f:
            f.write(text)
    print("done.")


if __name__ == "__main__":
    main()
