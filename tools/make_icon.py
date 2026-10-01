"""Draw the NBG Hub app icon: a hub-and-spoke mark (a central node linked to six nodes) on a rounded dark-green tile.

    python tools/make_icon.py          # needs Pillow (a developer tool only; the build does NOT need it)

Writes assets/nbg-hub.ico (16-256 px), assets/nbg-hub-256.png and web/hub-mark.svg. The generated files are committed,
so only change this script if you want a different design. Colours are the app's own palette.
"""
from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DARK = (24, 43, 38)        # --darker
TILE = (33, 59, 52)        # --dark
GREEN = (0, 120, 45)       # --medh
LIGHT = (161, 206, 173)    # --light
WHITE = (238, 244, 241)


def draw(size: int, detail: bool = True) -> Image.Image:
    """One icon at `size` px. Small sizes (< 48) drop the outer ring and use fatter spokes so they stay legible."""
    S = 1024
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=TILE)
    # soft inner glow toward the top for depth
    glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((S * 0.1, -S * 0.35, S * 0.9, S * 0.55), fill=(0, 120, 45, 70))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=255)
    im = Image.composite(Image.alpha_composite(im, glow), im, mask)
    d = ImageDraw.Draw(im)

    cx = cy = S / 2
    R = S * 0.30                                   # distance of the outer nodes from the centre
    small = size < 48
    spoke_w = int(S * (0.075 if small else 0.045))
    node_r = S * (0.105 if small else 0.085)
    hub_r = S * (0.175 if small else 0.15)
    pts = [(cx + R * math.cos(math.radians(a - 90)), cy + R * math.sin(math.radians(a - 90))) for a in range(0, 360, 60)]

    if detail and not small:
        d.ellipse((cx - R, cy - R, cx + R, cy + R), outline=(161, 206, 173, 70), width=int(S * 0.012))   # faint ring
    for (x, y) in pts:                              # spokes first, nodes on top
        d.line((cx, cy, x, y), fill=LIGHT, width=spoke_w)
    for (x, y) in pts:
        d.ellipse((x - node_r, y - node_r, x + node_r, y + node_r), fill=WHITE)
        if not small:
            d.ellipse((x - node_r * 0.45, y - node_r * 0.45, x + node_r * 0.45, y + node_r * 0.45), fill=GREEN)
    d.ellipse((cx - hub_r * 1.28, cy - hub_r * 1.28, cx + hub_r * 1.28, cy + hub_r * 1.28), fill=(0, 120, 45, 90))   # halo
    d.ellipse((cx - hub_r, cy - hub_r, cx + hub_r, cy + hub_r), fill=GREEN)
    d.ellipse((cx - hub_r * 0.58, cy - hub_r * 0.58, cx + hub_r * 0.58, cy + hub_r * 0.58), fill=WHITE)
    return im.resize((size, size), Image.LANCZOS)


def svg() -> str:
    """The same mark as a vector (sidebar). 100x100 viewBox."""
    c, R = 50, 30
    pts = [(c + R * math.cos(math.radians(a - 90)), c + R * math.sin(math.radians(a - 90))) for a in range(0, 360, 60)]
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
           f'<rect width="100" height="100" rx="22" fill="rgb{TILE}"/>',
           f'<circle cx="50" cy="50" r="{R}" fill="none" stroke="rgb{LIGHT}" stroke-opacity=".28" stroke-width="1.2"/>']
    out += [f'<line x1="50" y1="50" x2="{x:.1f}" y2="{y:.1f}" stroke="rgb{LIGHT}" stroke-width="4.5" stroke-linecap="round"/>' for x, y in pts]
    for x, y in pts:
        out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="8.5" fill="rgb{WHITE}"/><circle cx="{x:.1f}" cy="{y:.1f}" r="3.8" fill="rgb{GREEN}"/>')
    out.append(f'<circle cx="50" cy="50" r="19" fill="rgb{GREEN}" fill-opacity=".35"/><circle cx="50" cy="50" r="15" fill="rgb{GREEN}"/>'
               f'<circle cx="50" cy="50" r="8.7" fill="rgb{WHITE}"/></svg>')
    return "".join(out)


def main() -> None:
    os.makedirs(os.path.join(ROOT, "assets"), exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw(s) for s in sizes]
    ico = os.path.join(ROOT, "assets", "nbg-hub.ico")
    frames[-1].save(ico, format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    frames[-1].save(os.path.join(ROOT, "assets", "nbg-hub-256.png"))
    with open(os.path.join(ROOT, "web", "hub-mark.svg"), "w", encoding="utf-8") as f:
        f.write(svg())
    print("wrote assets/nbg-hub.ico, assets/nbg-hub-256.png, web/hub-mark.svg")


if __name__ == "__main__":
    main()
