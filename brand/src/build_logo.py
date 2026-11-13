#!/usr/bin/env python3
"""locus logo generator.

Every symbol is constructed analytically from circular arcs and straight
lines (no tracing, no boolean plug-ins) and emitted as plain SVG paths.
The wordmark is set from Geist outlines stored in geist-outlines.json.

    python3 build_logo.py            # write all SVGs + export manifest
    python3 build_logo.py --qa FILE  # write a QA sheet of symbol variants
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "logo"))

FOREST, PINK, BLUSH, LEAF, IVORY = "#102F29", "#E9A0B6", "#F3C8D4", "#275747", "#F7F3ED"
O = np.zeros(2)


# ───────────────────────── geometry kit (maths coords, y-up) ─────────────────

def unit(deg):
    a = math.radians(deg)
    return np.array([math.cos(a), math.sin(a)])


def rot(p, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([c * p[0] - s * p[1], s * p[0] + c * p[1]])


def cc(c1, r1, c2, r2):
    """Both intersection points of two circles."""
    c1, c2 = np.asarray(c1, float), np.asarray(c2, float)
    d = np.linalg.norm(c2 - c1)
    a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
    h = math.sqrt(max(r1 * r1 - a * a, 0))
    m = c1 + a * (c2 - c1) / d
    n = np.array([-(c2 - c1)[1], (c2 - c1)[0]]) / d
    return m + h * n, m - h * n


def arc_params(p, q, c, long=False):
    a0 = math.atan2(p[1] - c[1], p[0] - c[0])
    a1 = math.atan2(q[1] - c[1], q[0] - c[0])
    d = (a1 - a0 + math.pi) % (2 * math.pi) - math.pi
    if long:
        d -= math.copysign(2 * math.pi, d)
    return a0, d, float(np.linalg.norm(np.asarray(p) - c))


class Loop:
    """A closed outline made of straight lines and circular arcs."""

    def __init__(self, start):
        self.start = np.asarray(start, float)
        self.cur = self.start
        self.segs = []

    def L(self, q):
        q = np.asarray(q, float)
        self.segs.append(("L", self.cur, q))
        self.cur = q
        return self

    def A(self, q, c, long=False):
        q, c = np.asarray(q, float), np.asarray(c, float)
        self.segs.append(("A", self.cur, q, c, long))
        self.cur = q
        return self

    def map(self, f):
        out = Loop(f(self.start))
        for s in self.segs:
            if s[0] == "L":
                out.L(f(s[2]))
            else:
                out.A(f(s[2]), f(s[3]), s[4])
        return out

    def mirror(self):
        return self.map(lambda p: np.array([-p[0], p[1]]))

    def rotate(self, deg):
        return self.map(lambda p: rot(p, deg))

    def shift(self, v):
        return self.map(lambda p: p + np.asarray(v, float))

    def scale(self, k):
        return self.map(lambda p: p * k)

    def flat(self, per_rad=120):
        pts = [self.start]
        for s in self.segs:
            if s[0] == "L":
                pts.append(s[2])
            else:
                a0, d, r = arc_params(s[1], s[2], s[3], s[4])
                n = max(2, int(abs(d) * per_rad))
                for i in range(1, n + 1):
                    a = a0 + d * i / n
                    pts.append(s[3] + r * np.array([math.cos(a), math.sin(a)]))
        return np.array(pts)

    def d(self, f, nd=2):
        fmt = lambda p: " ".join(f"{round(float(v), nd):g}" for v in f(p))
        out = ["M" + fmt(self.start)]
        for s in self.segs:
            if s[0] == "L":
                out.append("L" + fmt(s[2]))
                continue
            _, p, q, c, lg = s
            a0, d, r = arc_params(p, q, c, lg)
            n = max(1, math.ceil(abs(d) / (math.pi / 2) - 1e-9))
            st = d / n
            k = 4 / 3 * math.tan(st / 4)
            for i in range(n):
                s0, s1 = a0 + i * st, a0 + (i + 1) * st
                p0 = c + r * np.array([math.cos(s0), math.sin(s0)])
                p3 = q if i == n - 1 else c + r * np.array([math.cos(s1), math.sin(s1)])
                p1 = p0 + k * r * np.array([-math.sin(s0), math.cos(s0)])
                p2 = (c + r * np.array([math.cos(s1), math.sin(s1)])) - k * r * np.array([-math.sin(s1), math.cos(s1)])
                out.append("C" + fmt(p1) + " " + fmt(p2) + " " + fmt(p3))
        return "".join(out) + "Z"


def clip_y(loop, y0):
    """Keep the part of a loop above the horizontal line y = y0 (flat base)."""
    pieces = []
    for s in loop.segs:
        if s[0] == "L":
            p, q = s[1], s[2]
            ts = [0.0, 1.0]
            if (p[1] - y0) * (q[1] - y0) < 0:
                ts.insert(1, (y0 - p[1]) / (q[1] - p[1]))
            for t1, t2 in zip(ts, ts[1:]):
                a, b = p + (q - p) * t1, p + (q - p) * t2
                if (a[1] + b[1]) / 2 >= y0:
                    pieces.append(["L", a, b])
        else:
            _, p, q, c, lg = s
            a0, d, r = arc_params(p, q, c, lg)
            ts = [0.0, 1.0]
            dy = y0 - c[1]
            if abs(dy) < r:
                dx = math.sqrt(r * r - dy * dy)
                for x in (c[0] - dx, c[0] + dx):
                    ang = math.atan2(dy, x - c[0])
                    rel = (ang - a0) % (2 * math.pi) if d > 0 else -((a0 - ang) % (2 * math.pi))
                    t = rel / d
                    if 1e-9 < t < 1 - 1e-9:
                        ts.append(t)
            ts.sort()
            at = lambda t: p if t == 0 else q if t == 1 else np.array(
                [c[0] + r * math.cos(a0 + d * t), y0])
            for t1, t2 in zip(ts, ts[1:]):
                am = a0 + d * (t1 + t2) / 2
                if c[1] + r * math.sin(am) >= y0:
                    pieces.append(["A", at(t1), at(t2), c, abs(d * (t2 - t1)) > math.pi])
    out = Loop(pieces[0][1])
    for pc in pieces:
        if np.linalg.norm(out.cur - pc[1]) > 1e-7:
            out.L(pc[1])
        if pc[0] == "L":
            out.L(pc[2])
        else:
            out.A(pc[2], pc[3], pc[4])
    if np.linalg.norm(out.cur - out.start) > 1e-7:
        out.L(out.start)
    return out


def lens(base, deg, L, alpha):
    """Vesica petal from `base` along `deg`; alpha = half-angle at the tips."""
    base = np.asarray(base, float)
    a = unit(deg)
    n = np.array([-a[1], a[0]])
    R = L / (2 * math.sin(math.radians(alpha)))
    d = R * math.cos(math.radians(alpha))
    mid = base + a * L / 2
    return dict(base=base, tip=base + a * L, n=n, R=R, cl=mid - d * n, cr=mid + d * n)


def lens_loop(l):
    return Loop(l["base"]).A(l["tip"], l["cl"]).A(l["base"], l["cr"])


def _pick(pts, l, side, far=False):
    sgn = 1 if side == "l" else -1
    ok = [p for p in pts if sgn * float(np.dot(p - l["base"], l["n"])) >= -1e-9] or list(pts)
    ok.sort(key=lambda p: np.linalg.norm(p - l["base"]), reverse=far)
    return ok[0]


def min_dist(a, b):
    A, B = a.flat(400), b.flat(400)
    return float(np.sqrt(((A[:, None, :] - B[None, :, :]) ** 2).sum(-1)).min())


# ───────────────────────── the three symbols ─────────────────────────────────

def sym_geometric(step=33, Ls=(1.0, 0.9, 0.78), al=(50, 50, 50), g=0.055, base=0.09):
    """01 — five vesica petals, layered front to back with one constant gap,
    all standing on a single flat baseline."""
    c = lens(O, 90, Ls[0], al[0])
    loops, front = [lens_loop(c)], c
    for i in range(1, len(Ls)):
        b = lens(O, 90 + step * i, Ls[i], al[i])
        Dc, Dr = front["cl"], front["R"] + g
        p1 = _pick(cc(b["cl"], b["R"], Dc, Dr), b, "l")
        p2 = _pick(cc(b["cr"], b["R"], Dc, Dr), b, "r", far=True)
        lp = Loop(p1).A(b["tip"], b["cl"]).A(p2, b["cr"]).A(p1, Dc)
        loops += [lp, lp.mirror()]
        front = b
    if base is not None:
        loops = [clip_y(l, base) for l in loops]
    return loops, False


def sym_negative(step=50, alpha=60, delta=0.05):
    """02 — three broad petals fused into one silhouette; the places where the
    petals overlap are carved out, leaving two inner petals of pure space."""
    R_, C_, L_ = (lens(O, 90 - step, 1, alpha), lens(O, 90, 1, alpha), lens(O, 90 + step, 1, alpha))
    far = lambda pts: max(pts, key=lambda q: np.linalg.norm(q))
    near = lambda pts: min(pts, key=lambda q: np.linalg.norm(q))
    n_rc = far(cc(R_["cl"], R_["R"], C_["cr"], C_["R"]))
    n_cl = far(cc(C_["cl"], C_["R"], L_["cr"], L_["R"]))
    outline = (Loop(O).A(R_["tip"], R_["cr"]).A(n_rc, R_["cl"]).A(C_["tip"], C_["cr"])
               .A(n_cl, C_["cl"]).A(L_["tip"], L_["cr"]).A(O, L_["cl"]))
    r = C_["R"] - delta
    mx = lambda p: np.array([-p[0], p[1]])
    pts = cc(L_["cr"], r, C_["cl"], r)
    tl, bl = far(pts), near(pts)
    if r > abs(L_["cr"][0]) + 1e-9:  # the two voids cross the axis and merge into one V
        dx = math.sqrt(r * r - L_["cr"][0] ** 2)
        x_top = np.array([0, L_["cr"][1] + dx])
        x_bot = np.array([0, L_["cr"][1] - dx])
        void = (Loop(bl).A(x_bot, L_["cr"]).A(mx(bl), R_["cl"]).A(mx(tl), C_["cr"])
                .A(x_top, R_["cl"]).A(tl, L_["cr"]).A(bl, C_["cl"]))
        return [outline, void], True
    v = Loop(bl).A(tl, C_["cl"]).A(bl, L_["cr"])
    return [outline, v, v.mirror()], True


def _leaf(x0, y0, kind):
    if kind == "\\":
        t1, t2, c1, c2 = (x0, y0 + 1), (x0 + 1, y0), (x0, y0), (x0 + 1, y0 + 1)
    else:
        t1, t2, c1, c2 = (x0, y0), (x0 + 1, y0 + 1), (x0 + 1, y0), (x0, y0 + 1)
    return Loop(t1).A(t2, c1).A(t1, c2)


def sym_modular(g=0.09, outer_drop=0.0):
    """03 — one leaf module (a unit square with two corners rounded to the full
    side), used five times: four slid sideways, one turned upright, and the
    same gap g between every neighbouring pair."""
    il = _leaf(-1 - g / 2, 0, "\\")
    pitch = (2 - math.sqrt(2) + g) * math.sqrt(2)  # leaf width + gap, measured along x
    ol = _leaf(-1 - g / 2 - pitch, -outer_drop, "\\")
    up0 = _leaf(-0.5, -0.5, "\\").rotate(-45)  # tips now vertical, centred on origin
    h = math.sqrt(2) / 2
    lo, hi = 0.0, 1.5
    for _ in range(40):  # seat the upright leaf exactly one gap above the cradle
        mid = (lo + hi) / 2
        if min_dist(up0.shift((0, mid + h)), il) < g:
            lo = mid
        else:
            hi = mid
    up = up0.shift((0, hi + h))
    return [ol, il, up, il.mirror(), ol.mirror()], False


def sym_hub(n=5, step=40, g=0.075, r0=0.2, rs=0.6, r1=1.0):
    """alt 03 — identical petal modules docked around a shared core."""
    beta = step / 2
    u = unit(90 - beta)
    n_in = np.array([-u[1], u[0]])
    P = lambda r: (g / 2) * n_in + math.sqrt(r * r - g * g / 4) * u
    a, J, T = P(r0), P(rs), np.array([0, r1])
    Ra = np.dot(T - J, T - J) / (2 * np.dot(T - J, n_in))
    C = J + n_in * Ra
    mx = lambda p: np.array([-p[0], p[1]])
    k = Loop(a).L(J).A(T, C).A(mx(J), mx(C)).L(mx(a)).A(a, O)
    return [k.rotate(step * (i - (n - 1) / 2)) for i in range(n)], False


def normalise(loops):
    """Centre on the bounding box and scale to unit height. Returns loops, width."""
    pts = np.concatenate([l.flat() for l in loops])
    lo, hi = pts.min(0), pts.max(0)
    k = 1 / (hi[1] - lo[1])
    c = (lo + hi) / 2
    return [l.shift(-c).scale(k) for l in loops], float((hi[0] - lo[0]) * k)


# ───────────────────────── wordmark ──────────────────────────────────────────

FONT = json.load(open(os.path.join(HERE, "geist-outlines.json")))


def text_paths(s, size, x, baseline, weight="500", tracking=0.0, nd=2):
    """Outlined text. Returns (list of per-glyph path data, x_min, x_max)."""
    G = FONT["weights"][weight]
    k = size / FONT["upm"]
    pen, out, xs = 0.0, [], []
    for ch in s:
        g = G[ch]
        parts = []
        for c in g["d"]:
            if c[0] == "Z":
                parts.append("Z")
                continue
            v = c[1:]
            pts = []
            for i in range(0, len(v), 2):
                px = x + (pen + v[i]) * k
                pts += [px, baseline - v[i + 1] * k]
                xs.append(px)
            parts.append(c[0] + " ".join(f"{round(p, nd):g}" for p in pts))
        if parts:
            out.append("".join(parts))
        pen += g["adv"] + tracking * FONT["upm"]
    return out, (min(xs) if xs else x), (max(xs) if xs else x)


def text_width(s, size, weight="500", tracking=0.0):
    _, a, b = text_paths(s, size, 0, 0, weight, tracking)
    return a, b


# ───────────────────────── composition ───────────────────────────────────────

def symbol_svg(sym, cx, cy, height, fill):
    loops, evenodd = sym
    f = lambda p: (cx + p[0] * height, cy - p[1] * height)
    if evenodd:
        return f'<path id="symbol" fill="{fill}" fill-rule="evenodd" d="{"".join(l.d(f) for l in loops)}"/>'
    return f'<g id="symbol" fill="{fill}">' + "".join(f'<path d="{l.d(f)}"/>' for l in loops) + "</g>"


def wordmark_svg(x, baseline, size, fill, tracking):
    paths, a, b = text_paths("locus", size, x, baseline, "500", tracking)
    body = "".join(f'<path id="{ch}" d="{d}"/>' for ch, d in zip("locus", paths))
    return f'<g id="wordmark" fill="{fill}">{body}</g>', a, b


def doc(w, h, body, bg=None, radius=0):
    w, h = math.ceil(w - 1e-6), math.ceil(h - 1e-6)
    r = f'<rect width="{w:g}" height="{h:g}" rx="{radius:g}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:g}" height="{h:g}" viewBox="0 0 {w:g} {h:g}">'
            f"<title>locus</title>{r}{body}</svg>\n")


SIZE = 100            # wordmark em size in px; x-height 53, l-height 71
TRACK = -0.012        # wordmark tracking, em
XH = FONT["xHeight"] / FONT["upm"] * SIZE


def horizontal(sym, wr, hs, sym_fill, text_fill, bg=None, pad=None, ov=0.0):
    """Symbol left, wordmark right; the symbol stands on the wordmark baseline
    (ov = fraction of its height allowed to overshoot below, for round bases).
    hs = symbol height in px (wordmark em = 100)."""
    ws = wr * hs
    gap = 0.46 * SIZE
    pad = pad if pad is not None else 0.32 * SIZE
    up = max(hs * (1 - ov), 0.71 * SIZE)
    H = up + hs * ov + 2 * pad
    baseline = pad + up
    mid, dy = baseline + hs * ov - hs / 2, 0.0
    a, b = text_width("locus", SIZE, "500", TRACK)
    tx = pad + ws + gap - a
    wm, _, right = wordmark_svg(tx, baseline, SIZE, text_fill, TRACK)
    body = symbol_svg(sym, pad + ws / 2, mid + dy * hs, hs, sym_fill) + wm
    return doc(right + pad, H, body, bg)


def vertical(sym, wr, hs, sym_fill, text_fill, bg=None, pad=None):
    hs = hs * 1.45
    ws = wr * hs
    size = SIZE
    pad = pad if pad is not None else 0.4 * SIZE
    a, b = text_width("locus", size, "500", TRACK)
    tw = b - a
    W = max(ws, tw) + 2 * pad
    gap = 0.42 * SIZE
    baseline = pad + hs + gap + 0.725 * size
    wm, _, _ = wordmark_svg(W / 2 - tw / 2 - a, baseline, size, text_fill, TRACK)
    body = symbol_svg(sym, W / 2, pad + hs / 2, hs, sym_fill) + wm
    return doc(W, baseline + pad, body, bg)


def icon(sym, wr, sym_fill, bg=None, radius=0, box=512, fit=0.64, dy=0.0):
    hs = box * fit / max(wr, 1.0)
    body = symbol_svg(sym, box / 2, box / 2 + dy * hs, hs, sym_fill)
    return doc(box, box, body, bg, radius)


CONCEPTS = [
    dict(n=1, slug="geometric", name="geometric lotus", build=sym_geometric, hs=96, icon_dy=0.0, ov=0.0,
         note="five vesica petals, one gap, one baseline"),
    dict(n=2, slug="negative-space", name="negative-space lotus", build=sym_negative, hs=88, icon_dy=-0.03, ov=0.06,
         note="three petals, two more carved from the overlap"),
    dict(n=3, slug="modular", name="modular lotus", build=sym_modular, hs=70, icon_dy=0.0, ov=0.0,
         note="one leaf module, five times, one constant gap"),
]

VARIANTS = {  # name: (symbol, wordmark, background)
    "color-on-dark": (PINK, IVORY, None),
    "color-on-light": (PINK, FOREST, None),
    "green": (FOREST, FOREST, None),
    "black": ("#000000", "#000000", None),
    "white": ("#FFFFFF", "#FFFFFF", None),
    "color-with-background": (PINK, IVORY, FOREST),
}


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w").write(text)


def build_all():
    manifest = []
    for c in CONCEPTS:
        loops, eo = c["build"]()
        loops, wr = normalise(loops)
        sym = (loops, eo)
        c["sym"], c["wr"] = sym, wr
        base = f'locus-{c["n"]}-{c["slug"]}'
        root = os.path.join(OUT, f'{c["n"]}-{c["slug"]}')
        for v, (sf, tf, bg) in VARIANTS.items():
            pad_h = 0.6 * SIZE if bg else None
            files = {
                "horizontal": (horizontal(sym, wr, c["hs"], sf, tf, bg, pad_h, c["ov"]), 2400),
                "vertical": (vertical(sym, wr, c["hs"], sf, tf, bg, 0.7 * SIZE if bg else None), 1600),
                "icon": (icon(sym, wr, sf, bg, 0, 512, 0.6 if bg else 0.86, c["icon_dy"] if bg else 0), 1024),
            }
            for layout, (svg, px) in files.items():
                p = os.path.join(root, "svg", f"{base}-{layout}-{v}.svg")
                write(p, svg)
                manifest.append((p, os.path.join(root, "png", f"{base}-{layout}-{v}.png"), px))
        fav = os.path.join(root, "favicon")
        write(os.path.join(fav, "favicon.svg"), icon(sym, wr, PINK, FOREST, 112, 512, 0.66, c["icon_dy"]))
        manifest.append((os.path.join(fav, "favicon.svg"), os.path.join(fav, "_favicon-master.png"), 1024))
    write(os.path.join(OUT, "locus-logo-concepts.svg"), presentation())
    manifest.append((os.path.join(OUT, "locus-logo-concepts.svg"), os.path.join(OUT, "locus-logo-concepts.png"), 2400))
    write(os.path.join(HERE, "export-manifest.tsv"), "".join(f"{a}\t{b}\t{w}\n" for a, b, w in manifest))
    print(f"{len(manifest)} SVGs written under {OUT}")


def caption(s, x, y, size, fill, opacity=1.0, weight="400", tracking=0.02, anchor="start"):
    a, b = text_width(s, size, weight, tracking)
    if anchor == "end":
        x = x - (b - a)
    paths, _, _ = text_paths(s, size, x - a, y, weight, tracking)
    return f'<path fill="{fill}" fill-opacity="{opacity:g}" d="{"".join(paths)}"/>'


def presentation():
    """Three concepts, flat and front-facing, on forest green."""
    W, H, M = 1600, 1560, 96
    body = caption("locus", M, M + 8, 22, IVORY, 0.9, "500", 0)
    body += caption("identity concepts", W - M, M + 8, 22, IVORY, 0.5, anchor="end")
    row_h = (H - 2 * M - 70) / 3
    scale = 2.25
    for i, c in enumerate(CONCEPTS):
        top = M + 70 + i * row_h
        body += f'<rect x="{M}" y="{top:g}" width="{W - 2 * M}" height="1" fill="{LEAF}"/>'
        body += caption(f'0{c["n"]}', M, top + 46, 20, PINK, 1, "500")
        body += caption(c["name"], M + 44, top + 46, 20, IVORY, 0.92)
        body += caption(c["note"], W - M, top + 46, 20, IVORY, 0.5, anchor="end")
        sym, wr, hs = c["sym"], c["wr"], c["hs"]
        ws = wr * hs
        a, b = text_width("locus", SIZE, "500", TRACK)
        total = ws + 0.46 * SIZE + (b - a)
        cy = top + row_h / 2 + 26 + scale * 40
        x0 = W / 2 - total * scale / 2
        g = symbol_svg(sym, ws / 2, hs * c["ov"] - hs / 2, hs, PINK)
        wm, _, _ = wordmark_svg(ws + 0.46 * SIZE - a, 0, SIZE, IVORY, TRACK)
        body += f'<g transform="translate({x0:.2f} {cy:.2f}) scale({scale})">{g}{wm}</g>'
        # small-size proof: favicon tile at 48 / 32 / 16
        fx = W - M
        for s in (16, 32, 48):
            fx -= s
            hh = s * 0.66 / max(wr, 1.0)
            tile = (f'<rect x="{fx:g}" y="{top + row_h - 34 - s:g}" width="{s}" height="{s}" rx="{s * 0.22:g}" fill="{LEAF}"/>'
                    + symbol_svg(sym, fx + s / 2, top + row_h - 34 - s / 2 + c["icon_dy"] * hh, hh, PINK).replace(' id="symbol"', ""))
            body += tile
            fx -= 14
    body = body.replace(' id="symbol"', "").replace(' id="wordmark"', "")
    for ch in "locus":
        body = body.replace(f' id="{ch}"', "")
    return doc(W, H, body, FOREST)


def qa(path):
    cands = {
        "1e slim": sym_geometric(step=32, Ls=(1, .9, .78), al=(46, 46, 46), g=.05, base=0.09),
        "1f 33/50": sym_geometric(step=33, Ls=(1, .9, .78), al=(50, 50, 50), g=.055, base=0.09),
        "1g 34/50 low": sym_geometric(step=34, Ls=(1, .9, .76), al=(50, 50, 50), g=.055, base=0.07),
        "1h 32/52": sym_geometric(step=32, Ls=(1, .92, .8), al=(52, 50, 48), g=.055, base=0.1),
        "2a split 50/60": sym_negative(),
        "2f V 46/68": sym_negative(step=46, alpha=68, delta=0.045),
        "2g V 50/70": sym_negative(step=50, alpha=70, delta=0.05),
        "2h V 44/64": sym_negative(step=44, alpha=64, delta=0.04),
        "2i split 52/60 thin": sym_negative(step=52, alpha=60, delta=0.035),
        "3a g.09": sym_modular(),
        "3b g.07": sym_modular(g=0.07),
        "3c g.12": sym_modular(g=0.12),
        "3d drop": sym_modular(g=0.09, outer_drop=0.12),
    }
    cols, size = 5, 260
    rows = math.ceil(len(cands) / cols)
    W, H = cols * size, rows * size
    body = ""
    for i, (name, sym) in enumerate(cands.items()):
        loops, wr = normalise(sym[0])
        s = (loops, sym[1])
        x, y = (i % cols) * size, (i // cols) * size
        hs = 170 / max(wr, 1)
        body += symbol_svg(s, x + size / 2, y + 105, hs, PINK)
        body += symbol_svg(s, x + 26, y + size - 28, 32 / max(wr, 1), PINK)
        body += symbol_svg(s, x + 60, y + size - 28, 16 / max(wr, 1), PINK)
        body += f'<text x="{x + 84}" y="{y + size - 23}" fill="{IVORY}" font-family="Helvetica" font-size="13">{name}</text>'
    write(path, doc(W, H, body.replace(' id="symbol"', ""), FOREST))
    print(W, H)


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--qa":
        qa(sys.argv[2])
    else:
        build_all()
