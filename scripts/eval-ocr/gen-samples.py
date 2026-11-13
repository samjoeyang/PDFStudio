#!/usr/bin/env python3
"""
生成 OCR 评测样例：用项目自带的 Noto CJK 字体把已知文本渲染成 PNG，
ground truth 同时写成 <id>.ref.txt，供 scripts/eval-ocr/run.mjs 计算 CER。

这些样例是「干净渲染」的，仅用于打通评测链路、建立基线。
真实扫描件/拍照件才是压力测试，请把它们放进 samples/ 并追加到 manifest.json。
"""
import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageChops
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


# ---- 真实感困难样本 ----
# 目的：三张真实证件照片因含个人信息已从仓库移除，评测失去「翻拍场景」靶场。
# 这里用可公开复现的合成退化重建同类压力：纹理背景、斜向阴影、倾斜、
# 暗光低对比、密集小字。参考答案精确已知，可量化任何算法改动的前后差异。

TEXT_CARD = (
    "姓名  张明远\n"
    "性别  男      民族  汉\n"
    "出生  1985 年 3 月 12 日\n"
    "住址  河北省唐山市路北区建设南路 56 号\n"
    "公民身份号码  {}"
)

TEXT_DOC = (
    "发票代码 113022460111    发票号码 08264139\n"
    "购买方名称：唐山远明商贸有限公司\n"
    "纳税人识别号：91130203MA0E8K7X4Q\n"
    "货物或应税劳务名称：办公设备一批    金额 ￥12,860.00\n"
    "税率 13%    税额 ￥1,671.80    价税合计 ￥14,531.80\n"
    "销售方名称：路北区恒信办公用品经营部\n"
    "开票日期：2024 年 11 月 6 日    收款人：李芳    复核：王强"
)

TEXT_SMALL = (
    "一、结算方式：货到验收合格后三十日内一次性支付全款。\n"
    "二、交付地点：河北省唐山市路北区建设南路 56 号仓库。\n"
    "三、质量标准：符合国家标准 GB/T 19001 及双方确认的样品。\n"
    "四、违约责任：逾期交付按合同总额每日万分之三支付违约金。\n"
    "五、争议解决：协商不成时向合同签订地人民法院提起诉讼。\n"
    "六、合同份数：一式两份，甲乙双方各执一份，具有同等效力。\n"
    "七、附则：未尽事宜由双方另行签订书面补充协议。\n"
    "甲方（盖章）：唐山远明商贸有限公司    乙方（盖章）：恒信经营部"
)


def _clamp(v):
    return int(max(0, min(255, v)))


def _valid_id(base17):
    weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    return base17 + "10X98765432"[sum(int(d) * w for d, w in zip(base17, weights)) % 11]


def _render_lines(text, size, w, h, start_y=56, gap=1.9, bg=(252, 251, 248)):
    img = Image.new("RGB", (w, h), bg)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT, size)
    y = start_y
    for line in text.split("\n"):
        d.text((56, y), line, fill=(26, 28, 32), font=font)
        y += int(size * gap)
    return img


def _wood(w, h, seed=5):
    """木纹桌面：低频年轮 + 高频纹理 + 传感器噪声，模拟真实翻拍背景。"""
    rng = random.Random(seed)
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        phase = 2.6 * math.sin(y / 190.0)
        for x in range(w):
            v = (15 * math.sin(y / 15.0 + phase + x / 850.0)
                 + 6 * math.sin(y / 3.4 + x / 210.0)
                 + rng.gauss(0, 3.0))
            px[x, y] = (_clamp(170 + v), _clamp(128 + v * 0.82), _clamp(88 + v * 0.58))
    return img


def _save_jpeg(img, path, q=78, blur=0.5):
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    img.convert("RGB").save(path, "JPEG", quality=q)
    print(f"  wrote {os.path.relpath(path, ROOT)}  ({img.width}x{img.height})")


def _write_ref(sid, text):
    with open(os.path.join(OUT, sid + ".ref.txt"), "w", encoding="utf-8") as f:
        f.write(text)


def generate_hard():
    card_text = TEXT_CARD.format(_valid_id("13020319850312123"))

    # 1) 木纹桌面 + 白卡片 + 投影阴影 + 轻微旋转：复现真实证件照最大误差来源
    bg = _wood(1300, 900)
    card = _render_lines(card_text, 34, 1000, 560)
    card = card.rotate(1.6, expand=True, resample=Image.BICUBIC, fillcolor=(250, 249, 245))
    x0 = (1300 - card.width) // 2 + 6
    y0 = (900 - card.height) // 2
    shadow = Image.new("RGBA", (1300, 900), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rectangle([x0 + 16, y0 + 20, x0 + card.width + 16, y0 + card.height + 20],
                 fill=(0, 0, 0, 125))
    shadow = shadow.filter(ImageFilter.GaussianBlur(20))
    bg = Image.alpha_composite(bg.convert("RGBA"), shadow)
    bg.paste(card, (x0, y0))
    _save_jpeg(bg, os.path.join(OUT, "hard-wood.jpg"), q=76, blur=0.6)
    _write_ref("hard-wood", card_text)

    # 2) 白纸 + 斜向窗光阴影：检验局部二值化是否救得回暗区文字
    img = _render_lines(card_text, 36, 1200, 760)
    grad = Image.new("L", img.size)
    gp = grad.load()
    for y in range(img.height):
        for x in range(img.width):
            gp[x, y] = _clamp(255 - 105 * (x / img.width * 0.55 + y / img.height * 0.45))
    grad_rgb = Image.merge("RGB", (grad, grad, grad))
    img = ImageChops.multiply(img, grad_rgb)
    _save_jpeg(img, os.path.join(OUT, "hard-shade.jpg"), q=80, blur=0.7)
    _write_ref("hard-shade", card_text)

    # 3) 倾斜 4.2°：检验投影法纠偏后的版面分割
    img = _render_lines(TEXT_DOC, 30, 1240, 700, start_y=48, gap=2.0)
    img = img.rotate(4.2, expand=True, resample=Image.BICUBIC, fillcolor=(255, 255, 255))
    _save_jpeg(img, os.path.join(OUT, "hard-skew.jpg"), q=82, blur=0.6)
    _write_ref("hard-skew", TEXT_DOC)

    # 4) 暗光低对比 + 传感器噪声
    img = _render_lines(TEXT_DOC, 32, 1240, 700, start_y=48, gap=2.0)
    img = Image.blend(img, Image.new("RGB", img.size, (96, 96, 96)), 0.42)
    px = img.load()
    rng = random.Random(31)
    for _ in range(int(img.width * img.height * 0.012)):
        x, y = rng.randrange(img.width), rng.randrange(img.height)
        n = rng.randint(-28, 28)
        r, g, b = px[x, y]
        px[x, y] = (_clamp(r + n), _clamp(g + n), _clamp(b + n))
    _save_jpeg(img, os.path.join(OUT, "hard-dim.jpg"), q=72, blur=0.8)
    _write_ref("hard-dim", TEXT_DOC)

    # 5) 密集小字 8 行：专门暴露整页版面分割丢行
    img = _render_lines(TEXT_SMALL, 24, 1100, 640, start_y=34, gap=1.8)
    _save_jpeg(img, os.path.join(OUT, "hard-small.jpg"), q=84, blur=0.4)
    _write_ref("hard-small", TEXT_SMALL)
    print(f"  hard 样本参考答案：hard-wood / hard-shade / hard-skew / hard-dim / hard-small")


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

    generate_hard()
    print("done.")


if __name__ == "__main__":
    main()
