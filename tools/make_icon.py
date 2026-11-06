"""
生成 KimBoxPC 图标：深色圆角底 + 红色播放键 + 电视外框轮廓。
输出 icon.ico（多尺寸）与 icon.png（256）。
"""
from PIL import Image, ImageDraw, ImageFilter
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
S = 1024  # 先大图绘制，最后缩放

BG_TOP = (26, 31, 38)
BG_BOT = (13, 16, 20)
ACCENT = (229, 9, 20)
ACCENT_DARK = (150, 5, 14)
WHITE = (245, 248, 250)


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def vertical_gradient(size, top, bot):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        d.line([(0, y), (size, y)], fill=lerp(top, bot, y / max(1, size - 1)))
    return img


def build():
    img = vertical_gradient(S, BG_TOP, BG_BOT).convert("RGBA")

    # 柔和高光（左上）
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([-S * 0.35, -S * 0.45, S * 0.75, S * 0.55], fill=(255, 255, 255, 16))
    glow = glow.filter(ImageFilter.GaussianBlur(S * 0.06))
    img = Image.alpha_composite(img, glow)

    d = ImageDraw.Draw(img)

    # 电视外框
    margin = S * 0.16
    top = S * 0.26
    bottom = S * 0.70
    box = [margin, top, S - margin, bottom]
    d.rounded_rectangle(box, radius=S * 0.055, fill=(8, 10, 13, 255),
                        outline=(70, 82, 96, 255), width=int(S * 0.014))

    # 屏幕内柔光
    screen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(screen)
    sd.rounded_rectangle([box[0] + S * 0.022, box[1] + S * 0.022,
                          box[2] - S * 0.022, box[3] - S * 0.022],
                         radius=S * 0.04, fill=(30, 40, 54, 190))
    img = Image.alpha_composite(img, screen)
    d = ImageDraw.Draw(img)

    # 支架
    stand_w = S * 0.10
    stand_top = bottom
    stand_bot = bottom + S * 0.075
    d.rounded_rectangle([S / 2 - stand_w / 2, stand_top, S / 2 + stand_w / 2, stand_bot],
                        radius=S * 0.012, fill=(58, 68, 82, 255))
    d.rounded_rectangle([S * 0.30, stand_bot - S * 0.012, S * 0.70, stand_bot + S * 0.028],
                        radius=S * 0.016, fill=(72, 84, 98, 255))

    # 红色播放三角（带阴影）
    cx, cy = S * 0.5, (top + bottom) / 2
    r = S * 0.115
    tri = [
        (cx - r * 0.62, cy - r),
        (cx - r * 0.62, cy + r),
        (cx + r * 0.95, cy),
    ]
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sh = ImageDraw.Draw(shadow)
    sh.polygon([(x + S * 0.012, y + S * 0.012) for x, y in tri], fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(S * 0.018))
    img = Image.alpha_composite(img, shadow)

    d = ImageDraw.Draw(img)
    d.polygon(tri, fill=ACCENT)
    # 播放键高光
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hl)
    hd.polygon([(cx - r * 0.55, cy - r * 0.85), (cx - r * 0.55, cy - r * 0.1), (cx + r * 0.5, cy - r * 0.42)],
               fill=(255, 255, 255, 45))
    img = Image.alpha_composite(img, hl)

    # 圆角裁切
    mask = rounded_mask(S, int(S * 0.22))
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    big = build()
    png_path = os.path.join(ROOT, "icon.png")
    big.resize((512, 512), Image.LANCZOS).save(png_path, "PNG")

    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    ico_path = os.path.join(ROOT, "icon.ico")
    big.resize((256, 256), Image.LANCZOS).save(ico_path, format="ICO", sizes=sizes)
    print("生成:", png_path)
    print("生成:", ico_path)


if __name__ == "__main__":
    main()
