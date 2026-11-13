#!/usr/bin/env python3
"""locus — refined geometric lotus (final direction).

    python3 build_final.py && ./export_png.sh export-manifest-final.tsv

Changes against concept 01:
  symbol   – outer petals enlarged and lifted, petals widen slightly outward,
             gap opened from 5.5 % to 6 % of the height, baseline raised so
             every petal stands on a broader foot
  wordmark – Geist Medium with a custom straight 'l' (the hooked tail removed)
"""
import os
import re

import build_logo as B

OUT = os.path.join(B.OUT, "final-geometric")
NAME = "locus"

# ── symbol ───────────────────────────────────────────────────────────────────
ANGLES = (31, 63)            # lean of the 2nd and 3rd petal pair from vertical, degrees
LENGTHS = (1.0, 0.91, 0.83)  # petal lengths, centre outward
TIPS = (50, 51, 52)          # half-angle at the petal tip, degrees
GAP = 0.06                   # constant gap between layers
BASE = 0.105                 # height of the flat baseline cut


def sym_final():
    c = B.lens(B.O, 90, LENGTHS[0], TIPS[0])
    loops, front = [B.lens_loop(c)], c
    for th, L, al in zip(ANGLES, LENGTHS[1:], TIPS[1:]):
        b = B.lens(B.O, 90 + th, L, al)
        Dc, Dr = front["cl"], front["R"] + GAP
        p1 = B._pick(B.cc(b["cl"], b["R"], Dc, Dr), b, "l")
        p2 = B._pick(B.cc(b["cr"], b["R"], Dc, Dr), b, "r", far=True)
        lp = B.Loop(p1).A(b["tip"], b["cl"]).A(p2, b["cr"]).A(p1, Dc)
        loops += [lp, lp.mirror()]
        front = b
    return [B.clip_y(l, BASE) for l in loops]


# ── wordmark: custom straight 'l' ────────────────────────────────────────────
_l = B.FONT["weights"]["500"]["l"]
_stem_l, _stem_r, _asc = 75.2, 181.2, 710
_l["d"] = [["M", _stem_l, 0], ["L", _stem_l, _asc], ["L", _stem_r, _asc], ["L", _stem_r, 0], ["Z"]]
_l["adv"] = _stem_r + _stem_l  # same bearing on both sides of the stem
B.TRACK = -0.006

HS = 98  # symbol height in px when the wordmark em is 100

VARIANTS = dict(B.VARIANTS)


def nest(svg, x, y, w=None, h=None):
    """Place a generated SVG document inside a sheet."""
    W, H = (float(v) for v in re.search(r'width="([\d.]+)" height="([\d.]+)"', svg).groups())
    k = (w / W) if w else (h / H)
    inner = svg[svg.index("</title>") + 8: svg.rindex("</svg>")]
    inner = re.sub(r' id="[^"]+"', "", inner)
    return f'<svg x="{x:g}" y="{y:g}" width="{W * k:g}" height="{H * k:g}" viewBox="0 0 {W:g} {H:g}">{inner}</svg>', W * k, H * k


def sheet(sym, wr):
    W, H, M = 1600, 1500, 96
    cap = B.caption
    body = cap("locus", M, M + 8, 22, B.IVORY, 0.9, "500", 0)
    body += cap("logo — geometric lotus, refined", W - M, M + 8, 22, B.IVORY, 0.5, anchor="end")
    body += f'<rect x="{M}" y="{M + 70}" width="{W - 2 * M}" height="1" fill="{B.LEAF}"/>'
    # hero
    hero, hw, hh = nest(B.horizontal(sym, wr, HS, B.PINK, B.IVORY), 0, 0, w=1000)
    body += hero.replace('x="0" y="0"', f'x="{(W - hw) / 2:g}" y="{M + 70 + (560 - hh) / 2:g}"', 1)
    # panels
    top, ph, gap = M + 70 + 560, 420, 24
    pw = (W - 2 * M - 2 * gap) / 3
    panels = [
        (B.IVORY, B.horizontal(sym, wr, HS, B.PINK, B.FOREST), 0.72, "on light"),
        (B.LEAF, B.vertical(sym, wr, HS / 1.45 * 1.25, B.PINK, B.IVORY), 0.5, "stacked"),
        ("#0B211D", B.icon(sym, wr, B.PINK, B.FOREST, 112, 512, 0.66), 0.42, "icon"),
    ]
    for i, (bg, svg, frac, label) in enumerate(panels):
        x = M + i * (pw + gap)
        body += f'<rect x="{x:g}" y="{top}" width="{pw:g}" height="{ph}" fill="{bg}"/>'
        n, nw, nh = nest(svg, 0, 0, w=pw * frac)
        body += n.replace('x="0" y="0"', f'x="{x + (pw - nw) / 2:g}" y="{top + (ph - nh) / 2:g}"', 1)
        body += cap(label, x, top + ph + 36, 18, B.IVORY, 0.5)
    # mono + small sizes
    y = top + ph + 110
    body += f'<rect x="{M}" y="{y - 40}" width="{W - 2 * M}" height="1" fill="{B.LEAF}"/>'
    n, nw, nh = nest(B.horizontal(sym, wr, HS, "#FFFFFF", "#FFFFFF"), M, y, h=88)
    body += n
    bx = M + nw + 60
    body += f'<rect x="{bx}" y="{y}" width="{nw + 40:g}" height="88" fill="#FFFFFF"/>'
    n2, _, _ = nest(B.horizontal(sym, wr, HS, "#000000", "#000000"), bx + 20, y, h=88)
    body += n2
    fx = W - M
    for s in (16, 32, 48, 64):
        fx -= s
        t, _, _ = nest(B.icon(sym, wr, B.PINK, B.LEAF, 112, 512, 0.66), fx, y + 88 - s, w=s)
        body += t
        fx -= 16
    for i, (col, nm) in enumerate(((B.FOREST, "102f29"), (B.PINK, "e9a0b6"), (B.BLUSH, "f3c8d4"), (B.LEAF, "275747"), (B.IVORY, "f7f3ed"))):
        sx = M + i * 150
        body += f'<rect x="{sx}" y="{H - M - 40}" width="40" height="40" fill="{col}" stroke="{B.LEAF}"/>'
        body += cap(nm, sx + 52, H - M - 14, 16, B.IVORY, 0.6)
    return B.doc(W, H, body, B.FOREST)


def main():
    loops, wr = B.normalise(sym_final())
    sym = (loops, False)
    manifest = []
    for v, (sf, tf, bg) in VARIANTS.items():
        files = {
            "horizontal": (B.horizontal(sym, wr, HS, sf, tf, bg, 0.6 * B.SIZE if bg else None), 2400),
            "vertical": (B.vertical(sym, wr, HS, sf, tf, bg, 0.7 * B.SIZE if bg else None), 1600),
            "icon": (B.icon(sym, wr, sf, bg, 0, 512, 0.6 if bg else 0.86), 1024),
        }
        for layout, (svg, px) in files.items():
            p = os.path.join(OUT, "svg", f"{NAME}-{layout}-{v}.svg")
            B.write(p, svg)
            manifest.append((p, os.path.join(OUT, "png", f"{NAME}-{layout}-{v}.png"), px))
    fav = os.path.join(OUT, "favicon")
    B.write(os.path.join(fav, "favicon.svg"), B.icon(sym, wr, B.PINK, B.FOREST, 112, 512, 0.66))
    manifest.append((os.path.join(fav, "favicon.svg"), os.path.join(fav, "_favicon-master.png"), 1024))
    p = os.path.join(OUT, "locus-logo-final.svg")
    B.write(p, sheet(sym, wr))
    manifest.append((p, p[:-3] + "png", 2400))
    B.write(os.path.join(B.HERE, "export-manifest-final.tsv"), "".join(f"{a}\t{b}\t{w}\n" for a, b, w in manifest))
    print(len(manifest), "SVGs written under", OUT)


if __name__ == "__main__":
    main()
