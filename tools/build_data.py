#!/usr/bin/env python3
"""Bereitet die offenen Geodaten von M-V fuer das begehbare 3D-Modell auf.

Quellen (alle © GeoBasis-DE/M-V, Nutzung frei mit Quellenvermerk):
  - DGM1  (Gelaendehoehen, 1 m)          www.geodaten-mv.de/dienste/dgm_atom
  - nDOM  (Objekthoehen, 1 m -> Baeume)  www.geodaten-mv.de/dienste/ndom_atom
  - LoD2  (3D-Gebaeude, CityGML)         www.geodaten-mv.de/dienste/gebaeude_atom
  - DOP   (Luftbild, WMS)                www.geodaten-mv.de/dienste/adv_dop

Aufruf:  python3 tools/build_data.py [--cache ./cache]
Benoetigt: pip install -r tools/requirements.txt
"""
import argparse
import io
import json
import os
import struct
import urllib.request
import zipfile

import mapbox_earcut as earcut
import numpy as np
import tifffile
from lxml import etree
from PIL import Image, ImageDraw

# Ursprung des lokalen Koordinatensystems (ETRS89 / UTM 33N, EPSG:25833), nahe Am See 89
E0, N0 = 270900.0, 5944710.0
HALF = 600            # Ausschnitt: 1200 m x 1200 m
STEP = 2              # Rasterweite des Gelaendenetzes in m
BASE = 27.0           # Hoehe (m ue. NHN), die im Modell y = 0 entspricht
WATER = 27.78         # Wasserspiegel Pinnower See laut DGM1
TILE = "33_270_5944_2"  # 2x2-km-Kachel, die den Ausschnitt enthaelt
TILE_E, TILE_N = 270000, 5946000  # linke obere Ecke der Kachel
HOUSE_E, HOUSE_N = 270897.77, 5944710.27  # Am See 89 (OSM/Nominatim)
DOP_PX = 4096

URLS = {
    "dgm": "https://www.geodaten-mv.de/dienste/dgm_download?index=4&dataset=ca268792-s2q1-4a39-b34c-9ec5bf9a4469&file=dgm1_{t}_gtiff.tif",
    "ndom": "https://www.geodaten-mv.de/dienste/ndom_download?index=0&dataset=66b85dc1-404c-4fab-b652-d2501962912c&file=ndom_{t}_gtiff.tif",
    "lod2": "https://www.geodaten-mv.de/dienste/gebaeude_download?index=0&dataset=8397b554-5cb9-4274-8be8-c20490d9a6e8&file=lod2_{t}_gml.zip",
    "dop": "https://www.geodaten-mv.de/dienste/adv_dop?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=mv_dop&STYLES="
           "&CRS=EPSG:25833&BBOX={x0},{y0},{x1},{y1}&WIDTH={px}&HEIGHT={px}&FORMAT=image/png",
}

NS = {"gml": "http://www.opengis.net/gml", "bldg": "http://www.opengis.net/citygml/building/1.0"}


def fetch(url, path):
    if not os.path.exists(path):
        print("lade", url)
        req = urllib.request.Request(url, headers={"User-Agent": "pinnowwalk/0.1"})
        with urllib.request.urlopen(req, timeout=600) as r, open(path + ".part", "wb") as f:
            f.write(r.read())
        os.replace(path + ".part", path)
    return path


def to_local(e, n, h):
    return e - E0, h - BASE, N0 - n


def build_terrain(dgm, out):
    # Pixel liegen als Flaechen vor (PixelIsArea): der Mittelwert von 2x2 Pixeln ergibt die Hoehe an der Pixelecke.
    n = 2 * HALF // STEP + 1
    h = np.zeros((n, n), np.float32)
    for i in range(n):          # i: Zeile, Norden -> Sueden
        r = int(TILE_N - (N0 + HALF - i * STEP))
        for j in range(n):      # j: Spalte, Westen -> Osten
            c = int(E0 - HALF + j * STEP - TILE_E)
            h[i, j] = dgm[r - 1:r + 1, c - 1:c + 1].mean()
    q = np.round((h - BASE) * 100).astype("<u2")
    q.tofile(os.path.join(out, "terrain.bin"))
    print("Gelaende", n, "x", n, "Hoehe", h.min(), "-", h.max())
    return n


def build_dop(png, out):
    im = Image.open(png).convert("RGB")
    im.save(os.path.join(out, "dop_4k.jpg"), quality=82, optimize=True)
    im.resize((2048, 2048), Image.LANCZOS).save(os.path.join(out, "dop_2k.jpg"), quality=85, optimize=True)


def newell(pts):
    nrm = np.zeros(3)
    for a, b in zip(pts, np.roll(pts, -1, axis=0)):
        nrm += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    return nrm


def ring_points(ring):
    pl = ring.find("gml:posList", NS)
    vals = pl.text.split() if pl is not None else " ".join(p.text for p in ring.findall("gml:pos", NS)).split()
    pts = np.array(vals, float).reshape(-1, 3)
    if len(pts) > 1 and np.allclose(pts[0], pts[-1]):
        pts = pts[:-1]
    return pts


def triangulate(poly):
    rings = [ring_points(poly.find("gml:exterior/gml:LinearRing", NS))]
    rings += [ring_points(r) for r in poly.findall("gml:interior/gml:LinearRing", NS)]
    if len(rings[0]) < 3:
        return None
    allp = np.vstack(rings)
    nrm = newell(rings[0])
    drop = int(np.argmax(np.abs(nrm)))
    keep = [k for k in range(3) if k != drop]
    ends = np.cumsum([len(r) for r in rings]).astype(np.uint32)
    idx = earcut.triangulate_float64(allp[:, keep], ends)
    tris = allp[np.asarray(idx).reshape(-1, 3)]
    # Wicklung an der Newell-Normalen ausrichten, damit Normalen nach aussen zeigen
    t = tris
    cr = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
    flip = (cr @ nrm) < 0
    tris[flip] = tris[flip][:, ::-1]
    return tris, allp


def build_buildings(gml_bytes, out):
    roofs, walls, footprints = [], [], []
    house = None
    root = etree.parse(io.BytesIO(gml_bytes))
    for b in root.iter("{%s}Building" % NS["bldg"]):
        grounds = b.findall(".//bldg:GroundSurface//gml:Polygon", NS)
        if not grounds:
            continue
        gp = np.vstack([ring_points(g.find("gml:exterior/gml:LinearRing", NS)) for g in grounds])
        cx, cy = gp[:, 0].mean(), gp[:, 1].mean()
        if abs(cx - E0) > HALF - 5 or abs(cy - N0) > HALF - 5:
            continue
        for kind, target in (("RoofSurface", roofs), ("WallSurface", walls)):
            for poly in b.findall(".//bldg:%s//gml:Polygon" % kind, NS):
                res = triangulate(poly)
                if res is None:
                    continue
                tris = res[0].reshape(-1, 3)
                x, y, z = to_local(tris[:, 0], tris[:, 1], tris[:, 2])
                target.append(np.stack([x, y, z], 1).astype(np.float32))
        for g in grounds:
            ring = ring_points(g.find("gml:exterior/gml:LinearRing", NS))
            loc = [[round(e - E0, 2), round(N0 - n, 2)] for e, n, _ in ring]
            footprints.append(loc)
            if house is None and point_in_poly(HOUSE_E - E0, N0 - HOUSE_N, loc):
                house = {"x": round(float(ring[:, 0].mean() - E0), 2), "z": round(float(N0 - ring[:, 1].mean()), 2),
                         "top": round(float(b_top(b) - BASE), 2)}
    r = np.concatenate(roofs).ravel()
    w = np.concatenate(walls).ravel()
    with open(os.path.join(out, "buildings.bin"), "wb") as f:
        f.write(struct.pack("<II", r.size, w.size))
        f.write(r.astype("<f4").tobytes())
        f.write(w.astype("<f4").tobytes())
    with open(os.path.join(out, "footprints.json"), "w") as f:
        json.dump(footprints, f, separators=(",", ":"))
    print("Gebaeude: Dachdreiecke", r.size // 9, "Wanddreiecke", w.size // 9, "Grundrisse", len(footprints))
    return footprints, house


def b_top(b):
    zs = [float(v) for pl in b.findall(".//bldg:RoofSurface//gml:posList", NS) for v in pl.text.split()[2::3]]
    return max(zs) if zs else BASE


def point_in_poly(x, z, poly):
    inside = False
    for (x1, z1), (x2, z2) in zip(poly, poly[1:] + poly[:1]):
        if (z1 > z) != (z2 > z) and x < (x2 - x1) * (z - z1) / (z2 - z1) + x1:
            inside = not inside
    return inside


def build_trees(ndom, footprints, out):
    # Ausschnitt des nDOM (1 m) als Bild: Zeile 0 = Norden
    r0, c0 = int(TILE_N - (N0 + HALF)), int(E0 - HALF - TILE_E)
    a = ndom[r0:r0 + 2 * HALF, c0:c0 + 2 * HALF].astype(np.float32)
    a[~np.isfinite(a) | (a > 100)] = 0
    # Gebaeude ausmaskieren (Grundriss + 2 m Puffer)
    mask = Image.new("L", (2 * HALF, 2 * HALF), 0)
    d = ImageDraw.Draw(mask)
    for fp in footprints:
        d.polygon([(x + HALF, z + HALF) for x, z in fp], fill=255, outline=255)
    m = np.array(mask) > 0
    grow = m.copy()
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            grow |= np.roll(np.roll(m, dy, 0), dx, 1)
    a[grow] = 0
    # lokale Maxima in einem 7x7-Fenster = Baumspitzen
    rad = 3
    pad = np.pad(a, rad)
    mx = np.zeros_like(a)
    for dy in range(2 * rad + 1):
        for dx in range(2 * rad + 1):
            mx = np.maximum(mx, pad[dy:dy + a.shape[0], dx:dx + a.shape[1]])
    peak = (a >= 3.0) & (a >= mx - 1e-4)
    ys, xs = np.nonzero(peak)
    hs = a[ys, xs]
    x = xs + 0.5 - HALF
    z = ys + 0.5 - HALF
    rad_m = np.clip(0.22 * hs + 0.9, 1.4, 6.0)
    arr = np.stack([x * 10, z * 10, hs * 10, rad_m * 10], 1).round().astype("<i2")
    arr.tofile(os.path.join(out, "trees.bin"))
    print("Baeume", len(arr))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "cache"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)

    dgm = tifffile.imread(fetch(URLS["dgm"].format(t=TILE), os.path.join(a.cache, "dgm1.tif")))
    ndom = tifffile.imread(fetch(URLS["ndom"].format(t=TILE), os.path.join(a.cache, "ndom.tif")))
    lod2 = fetch(URLS["lod2"].format(t=TILE), os.path.join(a.cache, "lod2.zip"))
    dop = fetch(URLS["dop"].format(x0=E0 - HALF, y0=N0 - HALF, x1=E0 + HALF, y1=N0 + HALF, px=DOP_PX),
                os.path.join(a.cache, "dop.png"))

    n = build_terrain(dgm, a.out)
    build_dop(dop, a.out)
    with zipfile.ZipFile(lod2) as z:
        gml = z.read([nm for nm in z.namelist() if nm.lower().endswith(".gml")][0])
    footprints, house = build_buildings(gml, a.out)
    build_trees(ndom, footprints, a.out)

    meta = {
        "crs": "EPSG:25833", "origin": [E0, N0], "half": HALF, "base": BASE, "water": round(WATER - BASE, 2),
        "terrain": {"n": n, "step": STEP, "scale": 0.01},
        "house": dict(house or {"x": HOUSE_E - E0, "z": N0 - HOUSE_N, "top": 10}, label="Am See 89"),
        "attribution": "© GeoBasis-DE/M-V 2026 (DGM1, nDOM, LoD2, DOP)",
    }
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
    print("fertig:", meta["house"])


if __name__ == "__main__":
    main()
