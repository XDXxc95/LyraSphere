#!/usr/bin/env python3
"""
从 resources/icon-source.png 生成各端应用图标。

源图是一张透明底的 logo（内容为紫色 #9457FB 左右，宽高比约 1.37:1），
所以这里统一按「裁到实际内容 -> 居中 -> 按目标比例缩放」的方式摆放，
避免直接缩放整张画布时把源图自带的空白也一起带进去。

各类目标的安全区不同，缩放比例也不同：

  - 桌面 PNG / legacy Android 图标：整张画布都可见，logo 宽度取 78%
  - ic_launcher_round：会被圆形遮罩裁掉四角，按内切圆计算
  - ic_launcher_foreground：自适应图标，108dp 画布中只有中间 72dp 可见，
    且必须落在 66dp 的安全圆内，否则圆角遮罩会切到 logo

用法：python scripts/generate_icons.py
"""
import math
import struct
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / 'resources'
SOURCE = RESOURCES / 'icon-source.png'

ANDROID_RES = ROOT / 'android' / 'app' / 'src' / 'main' / 'res'
ANDROID_DENSITIES = {
    'mdpi': 1.0,
    'hdpi': 1.5,
    'xhdpi': 2.0,
    'xxhdpi': 3.0,
    'xxxhdpi': 4.0,
}

# legacy 图标：整张画布可见
LEGACY_BASE = 48
LEGACY_LOGO_WIDTH = 0.78
# round 图标：圆形遮罩，按内切圆收敛
ROUND_LOGO_WIDTH = 0.76
# 自适应图标 foreground：108dp 画布，logo 需落在 66dp 安全圆内
ADAPTIVE_BASE = 108
ADAPTIVE_SAFE_CIRCLE = 64

# 桌面端 PNG 源图尺寸
DESKTOP_PNG_SIZE = 1024

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
FAVICON_SIZES = [16, 32, 48]
# ICNS 的 PNG 类型块，见 https://en.wikipedia.org/wiki/Apple_Icon_Image_format
ICNS_ENTRIES = [
    ('icp4', 16),
    ('icp5', 32),
    ('ic11', 32),
    ('ic12', 64),
    ('ic07', 128),
    ('ic13', 256),
    ('ic08', 256),
    ('ic14', 512),
    ('ic09', 512),
    ('ic10', 1024),
]


def load_logo():
    """读源图并裁到非透明内容的边界框。"""
    image = Image.open(SOURCE).convert('RGBA')
    bbox = image.getchannel('A').point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox is None:
        raise SystemExit(f'{SOURCE} 全透明，没有可用的 logo 内容')
    return image.crop(bbox)


def compose(logo, size, logo_width):
    """把 logo 按指定宽度居中放到 size×size 的透明画布上。"""
    target_w = max(1, round(size * logo_width))
    target_h = max(1, round(target_w * logo.height / logo.width))
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.paste(logo.resize((target_w, target_h), Image.LANCZOS), (
        (size - target_w) // 2,
        (size - target_h) // 2,
    ))
    return canvas


def width_fitting_circle(logo, diameter_fraction):
    """logo 要完整落进画布内切圆时，宽度能占画布的比例。

    矩形对角线 = w * sqrt(1 + (1/aspect)^2)，令其等于圆的直径即可解出 w。
    """
    aspect = logo.width / logo.height
    return diameter_fraction / math.sqrt(1 + 1 / aspect**2)


def png_bytes(image):
    buffer = BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def dib_bytes(image):
    """把一个 RGBA 图编码成 ICO 内嵌的 BMP(DIB) 数据块。

    位图头里的 biHeight 要写成两倍实际高度，因为 DIB 后面还跟着一张 AND 掩码；
    像素按 BGRA、自下而上排列。
    """
    width, height = image.size
    pixels = image.load()

    xor = bytearray()
    for y in range(height - 1, -1, -1):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            xor += bytes((b, g, r, a))

    # 1bpp 掩码，每行补齐到 4 字节；1 表示透明
    stride = ((width + 31) // 32) * 4
    mask = bytearray()
    for y in range(height - 1, -1, -1):
        row = bytearray(stride)
        for x in range(width):
            if pixels[x, y][3] == 0:
                row[x >> 3] |= 0x80 >> (x & 7)
        mask += row

    header = struct.pack(
        '<IiiHHIIiiII',
        40, width, height * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0,
    )
    return header + bytes(xor) + bytes(mask)


def write_ico(path, logo, sizes, logo_width):
    """手写 ICO。

    不用 PIL 的 ICO 保存：它给每个尺寸都写 PNG 压缩块，而 Windows 官方只在
    256x256 上认可 PNG 块，小尺寸走 PNG 会让部分解码器（例如 .NET 的
    System.Drawing.Icon，构建工具链里很常见）直接报错。所以这里只在 256
    用 PNG，其余按传统 BMP 块写，与 ImageMagick / png-to-ico 的行为一致。
    """
    images = [(s, compose(logo, s, logo_width)) for s in sizes]

    entries, blobs, offset = b'', b'', 6 + 16 * len(images)
    for size, image in images:
        if size >= 256:
            data, kind = png_bytes(image), 'PNG'
        else:
            data, kind = dib_bytes(image), 'BMP'
        entries += struct.pack(
            '<BBBBHHII',
            size if size < 256 else 0,
            size if size < 256 else 0,
            0, 0, 1, 32, len(data), offset,
        )
        blobs += data
        offset += len(data)
        check_alpha(image, f'{path.name} {size}px')

    path.write_bytes(struct.pack('<HHH', 0, 1, len(images)) + entries + blobs)


def write_icns(path, logo):
    """手写 ICNS：外层是容器头，内部每块都是『4 字节类型 + 4 字节长度 + PNG』。"""
    chunks = b''
    for chunk_type, size in ICNS_ENTRIES:
        data = png_bytes(compose(logo, size, LEGACY_LOGO_WIDTH))
        chunks += chunk_type.encode('ascii') + struct.pack('>I', len(data) + 8) + data
    path.write_bytes(b'icns' + struct.pack('>I', len(chunks) + 8) + chunks)


def check_alpha(image, label):
    if image.getchannel('A').getextrema()[1] == 0:
        raise SystemExit(f'{label} 生成结果全透明，logo 没有画上去')


def main():
    if not SOURCE.exists():
        raise SystemExit(f'未找到源图 {SOURCE}')

    logo = load_logo()
    print(f'源图内容 {logo.width}x{logo.height}，宽高比 {logo.width / logo.height:.2f}:1')

    # --- 桌面端 ---
    desktop = compose(logo, DESKTOP_PNG_SIZE, LEGACY_LOGO_WIDTH)
    desktop.save(RESOURCES / 'icon.png')
    check_alpha(desktop, 'icon.png')
    print(f'  resources/icon.png            {desktop.width}x{desktop.height}')

    write_ico(RESOURCES / 'icon.ico', logo, ICO_SIZES, LEGACY_LOGO_WIDTH)
    print(f'  resources/icon.ico            {ICO_SIZES}')

    write_icns(RESOURCES / 'icon.icns', logo)
    print(f'  resources/icon.icns           {[s for _, s in ICNS_ENTRIES]}')

    write_ico(RESOURCES / 'favicon.ico', logo, FAVICON_SIZES, LEGACY_LOGO_WIDTH)
    compose(logo, 16, LEGACY_LOGO_WIDTH).save(RESOURCES / 'icon_16x16.png')
    print('  resources/favicon.ico         + icon_16x16.png')

    renderer_icon = ROOT / 'src' / 'renderer' / 'assets' / 'icon.png'
    compose(logo, 256, LEGACY_LOGO_WIDTH).save(renderer_icon)
    print('  src/renderer/assets/icon.png  256x256')

    # --- Android ---
    round_width = width_fitting_circle(logo, ROUND_LOGO_WIDTH)
    adaptive_width = width_fitting_circle(logo, ADAPTIVE_SAFE_CIRCLE / ADAPTIVE_BASE)

    for density, scale in ANDROID_DENSITIES.items():
        target = ANDROID_RES / f'mipmap-{density}'

        compose(logo, round(LEGACY_BASE * scale), LEGACY_LOGO_WIDTH).save(target / 'ic_launcher.png')
        compose(logo, round(LEGACY_BASE * scale), round_width).save(target / 'ic_launcher_round.png')

        foreground = compose(logo, round(ADAPTIVE_BASE * scale), adaptive_width)
        foreground.save(target / 'ic_launcher_foreground.png')

        print(f'  mipmap-{density:<8} ic_launcher {round(LEGACY_BASE * scale)}px, '
              f'foreground {foreground.width}px')

    background = ANDROID_RES / 'values' / 'ic_launcher_background.xml'
    background.write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<resources>\n'
        '    <!-- 自适应图标背景层：logo 自带透明底，这里保持全透明 -->\n'
        '    <color name="ic_launcher_background">#00000000</color>\n'
        '</resources>\n',
        encoding='utf-8',
    )
    print('  values/ic_launcher_background.xml  -> #00000000（透明）')


if __name__ == '__main__':
    main()
