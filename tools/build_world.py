#!/usr/bin/env python3
"""Baut die Kacheln fuer die begehbare Weltkarte rund um Pinnow (welt.html).

Ausschnitt 14 km x 14 km, zerlegt in 1-km-Kacheln. Der Browser laedt nur die Kacheln
im Umkreis von 3 km um den Spieler. Bewusst grob ("Pixelgrafik"):
  - Gelaende aus DGM1, auf 10 m gemittelt
  - Bodenfarbe als 4-m-Pixelkarte: aus nDOM (Wald), DGM (ebene Wasserflaechen) und den
    Farben des Luftbilds abgeleitet und auf wenige Farben reduziert; das Luftbild selbst
    wird nicht gezeigt
  - Gebaeude aus LoD2 (echte Dachformen), einfarbig
  - Baeume: hoechstens einer je 25 m x 25 m (hoechste Stelle des nDOM)

Quellen (alle © GeoBasis-DE/M-V, Nutzung frei mit Quellenvermerk): DGM1, nDOM, LoD2, DOP.
Aufruf:  python3 tools/build_world.py [--cache DIR]
"""
import argparse
import io
import json
import os
import struct
import urllib.request
import zipfile

import numpy as np
import tifffile
from lxml import etree
from PIL import Image, ImageDraw
from scipy import ndimage

from build_data import triangulate, ring_points, NS

# Weltausschnitt (EPSG:25833): Nordwest-Ecke und Groesse in km
W_E, W_N = 264000, 5952000          # Nordwest-Ecke
KM = 14                              # 14 x 14 Kacheln
E0, N0 = 270794.0, 5944834.0         # Am See 16 = Ursprung des Modells
H_STEP = 10                          # Gelaenderaster in m
C_STEP = 4                           # Bodenfarbe in m je Pixel
TREE_CELL = 25                       # hoechstens ein Baum je Zelle (m)

URLS = {
    "dgm": "https://www.geodaten-mv.de/dienste/dgm_download?index=4&dataset=ca268792-s2q1-4a39-b34c-9ec5bf9a4469&file=dgm1_33_{e}_{n}_2_gtiff.tif",
    "ndom": "https://www.geodaten-mv.de/dienste/ndom_download?index=0&dataset=66b85dc1-404c-4fab-b652-d2501962912c&file=ndom_33_{e}_{n}_2_gtiff.tif",
    "lod2": "https://www.geodaten-mv.de/dienste/gebaeude_download?index=0&dataset=8397b554-5cb9-4274-8be8-c20490d9a6e8&file=lod2_33_{e}_{n}_2_gml.zip",
    "dop": "https://www.geodaten-mv.de/dienste/adv_dop?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=mv_dop&STYLES="
           "&CRS=EPSG:25833&BBOX={x0},{y0},{x1},{y1}&WIDTH={px}&HEIGHT={px}&FORMAT=image/png",
}

# Pixel-Palette des Bodens
PALETTE = [
    (64, 112, 176),   # 0 Wasser
    (44, 88, 50),     # 1 Hochwald
    (64, 110, 58),    # 2 niedriger Wald, Gebuesch
    (118, 164, 76),   # 3 Wiese, Rasen
    (150, 182, 88),   # 4 gruenes Feld
    (172, 140, 96),   # 5 Acker
    (214, 196, 140),  # 6 Sand, Feldweg
    (140, 138, 130),  # 7 befestigt
    (88, 140, 84),    # 8 Ufer, Schilf
]
ROOFS = [(150, 64, 48), (120, 52, 44), (92, 92, 98), (60, 62, 68), (130, 96, 70), (170, 90, 60)]
WALLS = [(232, 224, 206), (214, 200, 176), (196, 180, 160), (226, 214, 190), (150, 110, 80)]


def fetch(url, path):
    if not os.path.exists(path):
        req = urllib.request.Request(url, headers={"User-Agent": "pinnowwalk/0.2"})
        try:
            with urllib.request.urlopen(req, timeout=600) as r, open(path + ".part", "wb") as f:
                f.write(r.read())
        except Exception as ex:  # Kachel fehlt (z. B. ausserhalb von M-V)
            print("  fehlt:", url, ex)
            return None
        os.replace(path + ".part", path)
    return path


def block(a, k, fn):
    h, w = a.shape
    return fn(a.reshape(h // k, k, w // k, k), axis=(1, 3))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "cache", "welt"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "welt"))
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)

    n10, n4 = KM * 1000 // H_STEP, KM * 1000 // C_STEP
    H10 = np.full((n10, n10), np.nan, np.float32)      # mittlere Hoehe je 10-m-Zelle
    FLAT = np.full((n4, n4), 9.0, np.float32)          # Hoehenspanne je 4-m-Zelle (Wasser ist eben)
    VEG = np.zeros((n4, n4), np.float32)               # hoechster Bewuchs je 4-m-Zelle
    trees = []                                         # (E, N, h)
    buildings = {}                                     # Kachel -> Liste (Dreiecke, Farbe)

    mosaic = os.path.join(a.cache, "mosaic.npz")
    if os.path.exists(mosaic):
        z = np.load(mosaic, allow_pickle=True)
        H10, FLAT, VEG, trees, buildings = z["H10"], z["FLAT"], z["VEG"], list(z["trees"]), z["buildings"].item()
    else:
        for se in range(W_E, W_E + KM * 1000, 2000):
            for sn in range(W_N - KM * 1000, W_N, 2000):
                print("Quelle", se, sn)
                r0 = (W_N - (sn + 2000))           # Zeile (m) der Nordkante im Mosaik
                c0 = se - W_E
                key = f"{se // 1000}_{sn // 1000}"
                dgm_p = fetch(URLS["dgm"].format(e=se // 1000, n=sn // 1000), os.path.join(a.cache, f"dgm_{key}.tif"))
                if dgm_p is None:
                    continue
                dgm = tifffile.imread(dgm_p).astype(np.float32)
                dgm[(dgm < -50) | (dgm > 500)] = np.nan
                H10[r0 // 10:(r0 + 2000) // 10, c0 // 10:(c0 + 2000) // 10] = block(dgm, 10, np.nanmean)
                FLAT[r0 // 4:(r0 + 2000) // 4, c0 // 4:(c0 + 2000) // 4] = block(dgm, 4, np.nanmax) - block(dgm, 4, np.nanmin)
                os.remove(dgm_p)

                # Gebaeude (LoD2)
                foot = Image.new("L", (2000, 2000), 0)
                fd = ImageDraw.Draw(foot)
                lod_p = fetch(URLS["lod2"].format(e=se // 1000, n=sn // 1000), os.path.join(a.cache, f"lod2_{key}.zip"))
                if lod_p:
                    with zipfile.ZipFile(lod_p) as zf:
                        for nm in zf.namelist():
                            if nm.lower().endswith(".gml"):
                                read_buildings(zf.read(nm), buildings, fd, se, sn)

                # Bewuchs (nDOM) ohne Gebaeude
                ndom_p = fetch(URLS["ndom"].format(e=se // 1000, n=sn // 1000), os.path.join(a.cache, f"ndom_{key}.tif"))
                if ndom_p:
                    nd = tifffile.imread(ndom_p).astype(np.float32)
                    nd[~np.isfinite(nd) | (nd > 60) | (nd < 0)] = 0
                    m = ndimage.binary_dilation(np.array(foot) > 0, iterations=2)
                    nd[m] = 0
                    VEG[r0 // 4:(r0 + 2000) // 4, c0 // 4:(c0 + 2000) // 4] = block(nd, 4, np.max)
                    k = TREE_CELL
                    cells = nd.reshape(2000 // k, k, 2000 // k, k).transpose(0, 2, 1, 3).reshape(2000 // k, 2000 // k, k * k)
                    arg = cells.argmax(2)
                    hmax = cells.max(2)
                    for ci, cj in zip(*np.nonzero(hmax >= 5)):
                        dy, dx = divmod(int(arg[ci, cj]), k)
                        E = se + cj * k + dx + 0.5
                        N = sn + 2000 - (ci * k + dy + 0.5)
                        trees.append((E, N, float(hmax[ci, cj])))
                    os.remove(ndom_p)
        np.savez(mosaic, H10=H10, FLAT=FLAT, VEG=VEG, trees=np.array(trees, np.float32),
                 buildings=np.array(buildings, dtype=object))
    trees = np.array(trees, np.float32).reshape(-1, 3)
    print("Baeume gesamt", len(trees))

    # Luecken im Gelaende auffuellen (naechster Nachbar)
    bad = ~np.isfinite(H10)
    if bad.any():
        idx = ndimage.distance_transform_edt(bad, return_distances=False, return_indices=True)
        H10 = H10[tuple(idx)]

    tile_meta = {}
    overview = Image.new("RGB", (KM * 50, KM * 50))
    for ti in range(KM):            # Spalte, West -> Ost
        for tj in range(KM):        # Zeile, Nord -> Sued
            te, tn = W_E + ti * 1000, W_N - tj * 1000          # Nordwest-Ecke der Kachel
            name = f"{ti}_{tj}"
            # Hoehen an den Rasterpunkten = Mittel der vier umliegenden 10-m-Zellen
            R = np.arange(101) + tj * 100
            C = np.arange(101) + ti * 100
            rr = np.clip(np.stack([R - 1, R]), 0, n10 - 1)
            cc = np.clip(np.stack([C - 1, C]), 0, n10 - 1)
            hgt = sum(H10[np.ix_(rr[p], cc[q])] for p in (0, 1) for q in (0, 1)) / 4
            hq = np.clip(np.round(hgt * 10), 0, 65535).astype("<u2")

            # Bodenfarbe
            dop_p = fetch(URLS["dop"].format(x0=te, y0=tn - 1000, x1=te + 1000, y1=tn, px=500),
                          os.path.join(a.cache, f"dop_{name}.png"))
            if dop_p:
                dop = np.asarray(Image.open(dop_p).convert("RGB"), np.float32)
                dop = dop.reshape(250, 2, 250, 2, 3).mean((1, 3))
            else:
                dop = np.full((250, 250, 3), 120, np.float32)
            sl = (slice(tj * 250, tj * 250 + 250), slice(ti * 250, ti * 250 + 250))
            cls = classify(dop, VEG[sl], FLAT[sl])
            rgb = np.array(PALETTE, np.uint8)[cls]
            img = Image.fromarray(rgb).quantize(colors=len(PALETTE), method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            img.save(os.path.join(a.out, f"{name}.png"), optimize=True)
            overview.paste(Image.fromarray(rgb).resize((50, 50), Image.NEAREST), (ti * 50, tj * 50))

            # Baeume der Kachel (lokal in dm ab Nordwest-Ecke)
            sel = (trees[:, 0] >= te) & (trees[:, 0] < te + 1000) & (trees[:, 1] <= tn) & (trees[:, 1] > tn - 1000)
            tr = trees[sel]
            tq = np.stack([(tr[:, 0] - te) * 10, (tn - tr[:, 1]) * 10, tr[:, 2] * 10], 1).round().astype("<i2") \
                if len(tr) else np.zeros((0, 3), "<i2")

            # Gebaeude
            verts, cols = [], []
            for tris, ci in buildings.get(name, []):
                verts.append(np.stack([(tris[:, 0] - te) * 10, tris[:, 2] * 10, (tn - tris[:, 1]) * 10], 1))
                cols.append(np.full(len(tris) // 3, ci, np.uint8))
            vq = np.round(np.concatenate(verts)).astype("<i2") if verts else np.zeros((0, 3), "<i2")
            cq = np.concatenate(cols) if cols else np.zeros(0, np.uint8)

            with open(os.path.join(a.out, f"{name}.bin"), "wb") as f:
                f.write(struct.pack("<IIII", 101, len(tq), len(vq), 0))
                f.write(hq.tobytes()); f.write(tq.tobytes()); f.write(vq.tobytes()); f.write(cq.tobytes())
            tile_meta[name] = [int(len(tq)), int(len(vq) // 3)]
    overview.save(os.path.join(a.out, "overview.png"), optimize=True)

    meta = {
        "crs": "EPSG:25833", "origin": [E0, N0], "nw": [W_E, W_N], "tiles": KM, "tileSize": 1000,
        "hStep": H_STEP, "palette": PALETTE, "roofs": ROOFS, "walls": WALLS,
        "places": [
            {"name": "Am See 16", "e": 270794, "n": 5944834, "link": "diorama.html?ort=16"},
            {"name": "Flurstück 89", "e": 270823.3, "n": 5944872.5, "link": "diorama.html?ort=89"},
        ],
        "stats": tile_meta,
        "attribution": "© GeoBasis-DE/M-V 2026 (DGM1, nDOM, LoD2, DOP)",
    }
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump(meta, f, separators=(",", ":"), ensure_ascii=False)
    print("fertig", sum(v[0] for v in tile_meta.values()), "Baeume,",
          sum(v[1] for v in tile_meta.values()), "Gebaeudedreiecke")


def read_buildings(gml, buildings, fd, se, sn):
    root = etree.parse(io.BytesIO(gml))
    for b in root.iter("{%s}Building" % NS["bldg"]):
        grounds = b.findall(".//bldg:GroundSurface//gml:Polygon", NS)
        if not grounds:
            continue
        gp = np.vstack([ring_points(g.find("gml:exterior/gml:LinearRing", NS)) for g in grounds])
        cx, cy = gp[:, 0].mean(), gp[:, 1].mean()
        ti, tj = int((cx - W_E) // 1000), int((W_N - cy) // 1000)
        if not (0 <= ti < KM and 0 <= tj < KM):
            continue
        for g in grounds:
            ring = ring_points(g.find("gml:exterior/gml:LinearRing", NS))
            fd.polygon([(e - se, sn + 2000 - n) for e, n, _ in ring], fill=255, outline=255)
        seed = int(cx * 7 + cy * 13) & 0xFFFF
        roof_c, wall_c = seed % len(ROOFS), 10 + (seed // 7) % len(WALLS)
        lst = buildings.setdefault(f"{ti}_{tj}", [])
        for kind, ci in (("RoofSurface", roof_c), ("WallSurface", wall_c)):
            for poly in b.findall(".//bldg:%s//gml:Polygon" % kind, NS):
                try:
                    res = triangulate(poly)
                except Exception:
                    res = None
                if res is not None and len(res):
                    lst.append((np.asarray(res).reshape(-1, 3).astype(np.float64), ci))


def classify(dop, veg, flat):
    r, g, b = dop[..., 0], dop[..., 1], dop[..., 2]
    bright = (r + g + b) / 3
    sat = dop.max(2) - dop.min(2)
    cls = np.full(veg.shape, 3, np.uint8)                        # Wiese
    cls[(g >= r) & (bright > 105)] = 4                           # helles gruenes Feld
    cls[(r > g + 4) & (bright <= 150)] = 5                       # Acker
    cls[(r > g) & (bright > 150)] = 6                            # Sand
    cls[(sat < 12) & (bright > 120)] = 7                          # befestigt
    water = (flat < 0.03) & (veg < 1) & (bright < 110)
    water = ndimage.binary_opening(water, iterations=1)
    cls[water] = 0
    cls[(veg >= 2.5) & ~water] = 2
    cls[(veg >= 9) & ~water] = 1
    # Ufer: Wiese/Gebuesch direkt am Wasser
    shore = ndimage.binary_dilation(water, iterations=1) & ~water & (cls >= 3)
    cls[shore] = 8
    # kleine Flecken glaetten: wirkt wie gemalte Pixelgrafik
    votes = np.stack([ndimage.uniform_filter((cls == k).astype(np.float32), 3) for k in range(len(PALETTE))])
    keep = (cls == 0) | (cls == 8)                               # Uferlinie nicht wegglaetten
    return np.where(keep, cls, votes.argmax(0)).astype(np.uint8)


if __name__ == "__main__":
    main()
