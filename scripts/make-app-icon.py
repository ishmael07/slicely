"""Render the Mac app icon: build/icon.png (1024², used by a dev run's Dock tile)
and build/icon.icns (the packaged app). Apple's template: an 824×824 rounded
square centred on a transparent 1024 canvas, corner radius ≈ 22.4% of its
side, a soft shadow beneath — so it sits in the Dock at the same size and
shape as every other app. Pillow only; `iconutil` is part of macOS.

    python3 scripts/make-app-icon.py
"""
import math, os, shutil, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")
S = 1024
SS = 4  # supersample for clean edges
BODY = 824
RADIUS = round(BODY * 0.2237)
INSET = (S - BODY) // 2


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def gradient(size, top, bottom, angle_deg=90):
    """A linear gradient image, `angle_deg` measured from horizontal."""
    w, h = size
    img = Image.new("RGBA", size)
    px = img.load()
    a = math.radians(angle_deg)
    dx, dy = math.cos(a), math.sin(a)
    span = abs(w * dx) + abs(h * dy)
    for y in range(h):
        for x in range(w):
            t = ((x - w / 2) * dx + (y - h / 2) * dy) / span + 0.5
            px[x, y] = lerp(top, bottom, max(0.0, min(1.0, t)))
    return img


def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


def render():
    big = S * SS
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))

    # Shadow: the body's silhouette, blurred, offset down, low alpha.
    body_box = (INSET * SS, INSET * SS, (INSET + BODY) * SS, (INSET + BODY) * SS)
    shadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(body_box, radius=RADIUS * SS, fill=(0, 0, 0, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(radius=14 * SS))
    canvas.alpha_composite(shadow, (0, 10 * SS))

    # Body: near-black with a faint top-to-bottom lift, hairline highlight at the top edge.
    body = gradient((BODY * SS, BODY * SS), (28, 28, 33, 255), (12, 12, 14, 255), 90)
    mask = rounded_mask((BODY * SS, BODY * SS), RADIUS * SS)
    canvas.paste(body, (INSET * SS, INSET * SS), mask)
    ring = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(ring).rounded_rectangle(body_box, radius=RADIUS * SS, outline=(255, 255, 255, 22), width=2 * SS)
    canvas.alpha_composite(ring)

    # The mark: a diamond, coral→amber, with its own soft shadow, ~46% of the body.
    half = round(BODY * 0.23) * SS
    cx = cy = big // 2
    pts = [(cx, cy - half), (cx + half, cy), (cx, cy + half), (cx - half, cy)]
    dshadow = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    ImageDraw.Draw(dshadow).polygon(pts, fill=(255, 122, 69, 90))
    dshadow = dshadow.filter(ImageFilter.GaussianBlur(radius=22 * SS))
    canvas.alpha_composite(dshadow, (0, 6 * SS))
    dmask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(dmask).polygon(pts, fill=255)
    grad = gradient((big, big), (255, 122, 69, 255), (255, 177, 92, 255), 35)
    canvas.paste(grad, (0, 0), dmask)

    return canvas.resize((S, S), Image.LANCZOS)


def write_icns(png_path, icns_path):
    src = Image.open(png_path)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.mkdir(iconset)
        for size in (16, 32, 128, 256, 512):
            src.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}.png"))
            src.resize((size * 2, size * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{size}x{size}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", icns_path], check=True)


if __name__ == "__main__":
    os.makedirs(ROOT, exist_ok=True)
    png = os.path.join(ROOT, "icon.png")
    render().save(png, optimize=True)
    write_icns(png, os.path.join(ROOT, "icon.icns"))
    im = Image.open(png)
    assert im.getpixel((0, 0))[3] == 0, "corners must be transparent"
    print("wrote", png, im.size, "and icon.icns")
