#!/usr/bin/env python3
"""
生成 OCR 评测样例：用项目自带的 Noto CJK 字体把已知文本渲染成 PNG，
ground truth 同时写成 <id>.ref.txt，供 scripts/eval-ocr/run.mjs 计算 CER。

这些样例是「干净渲染」的，仅用于打通评测链路、建立基线。
真实扫描件/拍照件才是压力测试，请把它们放进 samples/ 并追加到 manifest.json。
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import random

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


def render_degraded(text: str, size: int, path: str, seed: int = 7,
                    blur: float = 0.8, noise: float = 0.015,
                    down: int = 3, jpeg_q: int = 72, shade: float = 0.35):
    """模拟手机拍照/低质量扫描：小字 + 倾斜 + 噪声 + 模糊 + 压缩感。

    这类输入才会触发形近字混淆错误（曰/日、O/0、只/识），用于检验后纠错层。
    参数可调出更重的退化（hard 模式）用于压力测试。
    """
    rng = random.Random(seed)
    font = ImageFont.truetype(FONT, size)
    lines = text.split("\n")
    line_h = int(size * 1.5)
    max_w = max(font.getlength(line) for line in lines)
    w = int(max_w) + PAD * 2
    h = line_h * len(lines) + PAD * 2

    # 1) 小字号渲染（比正常样本小一半，触发预处理 2x 放大路径）
    img = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(img)
    y = PAD
    for line in lines:
        d.text((PAD, y), line, fill=rng.randint(20, 60), font=font)
        y += line_h

    # 2) 轻微旋转（模拟拍照没拿正）
    img = img.rotate(rng.uniform(-2.5, 2.5), expand=True, fillcolor=255,
                     resample=Image.BICUBIC)

    # 3) 高斯模糊 + 椒盐噪声（模拟失焦与传感器噪声）
    img = img.filter(ImageFilter.GaussianBlur(blur))
    px = img.load()
    for _ in range(int(img.width * img.height * noise)):
        x, yy = rng.randrange(img.width), rng.randrange(img.height)
        px[x, yy] = rng.randint(0, 255)

    # 4) 局部光照不均（左上亮右下暗的渐变阴影）
    grad = Image.new("L", (img.width, img.height), 255)
    gd = ImageDraw.Draw(grad)
    for i in range(img.height):
        v = int(255 - (i / img.height) * 45)
        gd.line([(0, i), (img.width, i)], fill=v)
    img = Image.blend(img, grad, shade)

    # 5) 降采样再放大（模拟低分辨率采集）
    small = img.resize((img.width // down, img.height // down), Image.LANCZOS)
    img = small.resize((small.width * down, small.height * down), Image.BILINEAR)

    img.convert("RGB").save(path, "JPEG", quality=jpeg_q)
    print(f"  wrote {os.path.relpath(path, ROOT)}  ({img.width}x{img.height}, degraded)")


def main():
    os.makedirs(OUT, exist_ok=True)
    for sid, (text, size) in SAMPLES.items():
        png = os.path.join(OUT, sid + ".png")
        ref = os.path.join(OUT, sid + ".ref.txt")
        render(text, size, png)
        with open(ref, "w", encoding="utf-8") as f:
            f.write(text)

    # 降质样本：与 cn-paragraph 同文，供混淆纠错层检验
    noisy_text = SAMPLES["cn-paragraph"][0]
    render_degraded(noisy_text, 22, os.path.join(OUT, "cn-noisy.png"))
    with open(os.path.join(OUT, "cn-noisy.ref.txt"), "w", encoding="utf-8") as f:
        f.write(noisy_text)

    # 身份证号样本（校验位按 GB 11643-1999 MOD 11-2 现算，保证号码合法）
    base = "11010119900512371"
    weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    check = "10X98765432"[sum(int(d) * w for d, w in zip(base, weights)) % 11]
    id_number = base + check
    for sid, size, deg in [("id-number", 44, False), ("id-number-noisy", 26, True)]:
        p = os.path.join(OUT, sid + ".png")
        if deg:
            render_degraded(id_number, size, p, seed=11)
        else:
            render(id_number, size, p)
        with open(os.path.join(OUT, sid + ".ref.txt"), "w", encoding="utf-8") as f:
            f.write(id_number)

    # 高难度号码样本：小字 + 较重退化，验证白名单/校验码兜底的价值
    # （难度调校在"引擎会出错但仍可恢复"的区间，过狠会输出空串无参考价值）
    render_degraded(id_number, 24, os.path.join(OUT, "id-number-hard.png"),
                    seed=23, blur=1.0, noise=0.03, down=2, jpeg_q=65, shade=0.35)
    with open(os.path.join(OUT, "id-number-hard.ref.txt"), "w", encoding="utf-8") as f:
        f.write(id_number)
    print("done.")


if __name__ == "__main__":
    main()
