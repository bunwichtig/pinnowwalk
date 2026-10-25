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
from PIL import Image, ImageDraw, ImageFilter

# Ursprung des lokalen Koordinatensystems (ETRS89 / UTM 33N, EPSG:25833)
E0, N0 = 270794.0, 5944834.0  # Am See 16 (OSM/Nominatim), passt zum Kartenpunkt des Nutzers
HALF = 70             # Ausschnitt: 140 m x 140 m (begehbar: eigenes Grundstueck und Nachbarn)
WALK_RADIUS = 55
STEP = 1              # Rasterweite des Gelaendenetzes in m
BASE = 27.0           # Hoehe (m ue. NHN), die im Modell y = 0 entspricht
WATER = 27.78         # Wasserspiegel Pinnower See laut DGM1
TILE = "33_270_5944_2"  # 2x2-km-Kachel, die den Ausschnitt enthaelt
TILE_E, TILE_N = 270000, 5946000  # linke obere Ecke der Kachel
HOUSE_E, HOUSE_N = E0, N0
DOP_PX = 1024         # ca. 14 cm pro Pixel
TREE_SPACING = 9      # Mindestabstand der sinnbildlichen Baeume in m
TREE_MIN_H = 5
TREE_MAX = 16

URLS = {
    "dgm": "https://www.geodaten-mv.de/dienste/dgm_download?index=4&dataset=ca268792-s2q1-4a39-b34c-9ec5bf9a4469&file=dgm1_{t}_gtiff.tif",
    "ndom": "https://www.geodaten-mv.de/dienste/ndom_download?index=0&dataset=66b85dc1-404c-4fab-b652-d2501962912c&file=ndom_{t}_gtiff.tif",
    "lod2": "https://www.geodaten-mv.de/dienste/gebaeude_download?index=0&dataset=8397b554-5cb9-4274-8be8-c20490d9a6e8&file=lod2_{t}_gml.zip",
    "osm": "https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}",
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
    im.save(os.path.join(out, "dop.jpg"), quality=85, optimize=True)
    return np.asarray(im)


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


WALL_STYLES = ["putz", "klinker", "holz"]
# Farben nach den Fotos vor Ort: helle bis cremegelbe Fassaden, dunkelbraune Holzhuetten
PUTZ_FARBEN = [(0.96, 0.92, 0.80), (0.95, 0.88, 0.68), (0.94, 0.93, 0.90), (0.92, 0.86, 0.74)]
HOLZ_FARBEN = [(0.42, 0.30, 0.21), (0.50, 0.36, 0.25), (0.93, 0.84, 0.60), (0.55, 0.60, 0.52)]


def unit(v):
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def wall_uv(tris, nrm, z0):
    # u: Meter entlang der Wand, v: Meter ueber dem Gebaeudeboden (damit Fenster geschossweise sitzen)
    a = unit(np.array([-nrm[1], nrm[0], 0.0]))
    p = tris.reshape(-1, 3)
    u = (p - p[0]) @ a   # relativ zur Wand, sonst reicht die Float32-Genauigkeit im Browser nicht
    return np.stack([u - np.floor(u.min()), p[:, 2] - z0], 1)


def roof_uv(tris, nrm):
    p = tris.reshape(-1, 3) - tris.reshape(-1, 3).min(0)
    n = unit(nrm)
    if abs(n[2]) > 0.97:
        return p[:, :2].copy()
    a = unit(np.array([-n[1], n[0], 0.0]))   # Traufrichtung
    b = unit(np.cross(n, a))                 # Gefaellerichtung
    return np.stack([p @ a, p @ b], 1)


def roof_color(dop, pts):
    # mittlere Farbe des Luftbilds unter dem Dach (innerer Bereich, um Raender zu meiden)
    px = DOP_PX / (2 * HALF)
    cols = (pts[:, 0] - (E0 - HALF)) * px
    rows = ((N0 + HALF) - pts[:, 1]) * px
    c0, c1 = np.percentile(cols, [25, 75]).astype(int)
    r0, r1 = np.percentile(rows, [25, 75]).astype(int)
    c0, r0 = max(c0, 0), max(r0, 0)
    patch = dop[r0:max(r1, r0 + 1), c0:max(c1, c0 + 1)].reshape(-1, 3)
    if len(patch) == 0:
        return (0.55, 0.3, 0.25)
    col = np.median(patch, 0) / 255.0
    return tuple(np.clip(col * 1.15, 0.08, 0.95))


def area2d(pts):
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, 1)) - np.dot(y, np.roll(x, 1)))


def build_buildings(gml_bytes, dop, out):
    groups = {k: [] for k in ["dach"] + WALL_STYLES + ["schuppen"]}
    footprints = []
    house = None
    root = etree.parse(io.BytesIO(gml_bytes))
    for b in root.iter("{%s}Building" % NS["bldg"]):
        grounds = b.findall(".//bldg:GroundSurface//gml:Polygon", NS)
        if not grounds:
            continue
        grings = [ring_points(g.find("gml:exterior/gml:LinearRing", NS)) for g in grounds]
        gp = np.vstack(grings)
        cx, cy = gp[:, 0].mean(), gp[:, 1].mean()
        if abs(cx - E0) > HALF - 5 or abs(cy - N0) > HALF - 5:
            continue
        z0 = gp[:, 2].min()
        top = b_top(b)
        area = sum(area2d(r) for r in grings)
        seed = int.from_bytes(b.get("{http://www.opengis.net/gml}id", "x").encode()[-6:], "little")
        rng = np.random.default_rng(seed)
        if area < 30 or top - z0 < 2.8:
            style, wcol = "schuppen", (0.42, 0.31, 0.22) if rng.random() < 0.7 else (0.30, 0.50, 0.45)
        else:
            style = WALL_STYLES[int(rng.choice(3, p=[0.35, 0.1, 0.55]))]
            wcol = {"putz": PUTZ_FARBEN[int(rng.integers(len(PUTZ_FARBEN)))],
                    "klinker": (1.0, 1.0, 1.0), "holz": HOLZ_FARBEN[int(rng.integers(len(HOLZ_FARBEN)))]}[style]
        roof_pts = [ring_points(p.find("gml:exterior/gml:LinearRing", NS)) for p in b.findall(".//bldg:RoofSurface//gml:Polygon", NS)]
        rcol = roof_color(dop, np.vstack(roof_pts)) if roof_pts else (0.5, 0.3, 0.25)
        for kind in ("RoofSurface", "WallSurface"):
            for poly in b.findall(".//bldg:%s//gml:Polygon" % kind, NS):
                res = triangulate(poly)
                if res is None:
                    continue
                tris = res[0]
                nrm = newell(ring_points(poly.find("gml:exterior/gml:LinearRing", NS)))
                if kind == "RoofSurface":
                    uv, col, g = roof_uv(tris, nrm), rcol, groups["dach"]
                else:
                    uv, col, g = wall_uv(tris, nrm, z0), wcol, groups[style]
                p = tris.reshape(-1, 3)
                x, y, z = to_local(p[:, 0], p[:, 1], p[:, 2])
                c = np.tile(np.array(col, np.float32), (len(p), 1))
                g.append(np.column_stack([x, y, z, uv, c]).astype(np.float32))
        for ring in grings:
            loc = [[round(e - E0, 2), round(N0 - n, 2)] for e, n, _ in ring]
            footprints.append(loc)
            if house is None and point_in_poly(HOUSE_E - E0, N0 - HOUSE_N, loc):
                house = {"x": round(float(ring[:, 0].mean() - E0), 2), "z": round(float(N0 - ring[:, 1].mean()), 2),
                         "top": round(float(top - BASE), 2)}
    index, off = [], 0
    with open(os.path.join(out, "buildings.bin"), "wb") as f:
        for name, parts in groups.items():
            if not parts:
                continue
            arr = np.concatenate(parts).astype("<f4")
            f.write(arr.tobytes())
            index.append({"style": name, "offset": off, "count": len(arr)})
            off += len(arr)
    with open(os.path.join(out, "footprints.json"), "w") as f:
        json.dump(footprints, f, separators=(",", ":"))
    print("Gebaeude:", {g["style"]: g["count"] // 3 for g in index}, "Grundrisse", len(footprints))
    return footprints, house, index


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
    # lokale Maxima = Baumspitzen; danach nur gut verteilte, hohe Baeume behalten (sinnbildlich)
    rad = 3
    pad = np.pad(a, rad)
    mx = np.zeros_like(a)
    for dy in range(2 * rad + 1):
        for dx in range(2 * rad + 1):
            mx = np.maximum(mx, pad[dy:dy + a.shape[0], dx:dx + a.shape[1]])
    peak = (a >= TREE_MIN_H) & (a >= mx - 1e-4)
    ys, xs = np.nonzero(peak)
    hs = a[ys, xs]
    keep = []
    for k in np.argsort(-hs):
        if all((xs[k] - xs[q]) ** 2 + (ys[k] - ys[q]) ** 2 >= TREE_SPACING ** 2 for q in keep):
            keep.append(k)
    ys, xs, hs = ys[keep], xs[keep], hs[keep]
    x = xs + 0.5 - HALF
    z = ys + 0.5 - HALF
    inside = np.hypot(x, z) < WALK_RADIUS + 10
    x, z, hs = x[inside][:TREE_MAX], z[inside][:TREE_MAX], hs[inside][:TREE_MAX]
    rad_m = np.clip(0.22 * hs + 0.9, 1.4, 6.0)
    arr = np.stack([x * 10, z * 10, hs * 10, rad_m * 10], 1).round().astype("<i2")
    arr.tofile(os.path.join(out, "trees.bin"))
    print("Baeume", len(arr))


ROAD_WIDTH = {"residential": 4.0, "unclassified": 4.0, "service": 3.0, "track": 2.5, "living_street": 3.5,
              "footway": 1.2, "path": 1.0, "steps": 1.2}


def build_roads(osm_xml, out):
    from pyproj import Transformer
    tr = Transformer.from_crs(4326, 25833, always_xy=True)
    root = etree.fromstring(osm_xml)
    nodes = {nd.get("id"): tr.transform(float(nd.get("lon")), float(nd.get("lat"))) for nd in root.iter("node")}
    roads = []
    for way in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in way.iter("tag")}
        if tags.get("highway") not in ROAD_WIDTH:
            continue
        pts = [nodes[r.get("ref")] for r in way.iter("nd") if r.get("ref") in nodes]
        loc = [[round(e - E0, 2), round(N0 - n, 2)] for e, n in pts]
        if len(loc) >= 2:
            roads.append({"w": ROAD_WIDTH[tags["highway"]], "pts": loc})
    with open(os.path.join(out, "roads.json"), "w") as f:
        json.dump(roads, f, separators=(",", ":"))
    print("Wege", len(roads))


# Stege, aus dem Luftbild abgelesen (Landseite -> Seeende), in UTM-Abweichung von JETTY_REF
JETTIES = [((37.6, -117.1), (26.7, -122.5)), ((29.1, -104.0), (21.3, -110.0)), ((8.8, -74.0), (-2.0, -81.9)),
           ((-26.7, -35.0), (-34.5, -41.0)), ((-60.0, -18.0), (-67.0, -24.0)), ((-84.0, 17.3), (-90.0, 15.0)),
           ((-103.0, 85.0), (-110.0, 83.0))]
JETTY_REF = (270799.0, 5944835.0)
OUR_JETTY = 3  # dem GPS des Fotos vom eigenen Steg am naechsten


def build_ground(dop, ndom, footprints, roads_path, out):
    """Bodenarten als Gewichtskarte (R = Rasen, G = Waldboden mit Nadeln, B = Sand/Weg), 0,5 m pro Pixel.
    Ufer und Wasser ergeben sich im Browser aus der Hoehe."""
    res = 0.5
    n = int(2 * HALF / res)
    # Waldboden unter Baumkronen (nDOM > 4 m)
    r0, c0 = int(TILE_N - (N0 + HALF)), int(E0 - HALF - TILE_E)
    a = ndom[r0:r0 + 2 * HALF, c0:c0 + 2 * HALF].astype(np.float32)
    a[~np.isfinite(a) | (a > 100)] = 0
    canopy = Image.fromarray(((a > 4) * 255).astype(np.uint8)).resize((n, n), Image.BILINEAR)
    forest = np.asarray(canopy, np.float32) / 255
    # Sand: OSM-Wege plus helle, wenig gruene Stellen im Luftbild
    road = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(road)
    with open(roads_path) as f:
        for r in json.load(f):
            pts = [((x + HALF) / res, (z + HALF) / res) for x, z in r["pts"]]
            d.line(pts, fill=255, width=max(2, int((r["w"] + 1.5) / res)), joint="curve")
    road = np.asarray(road, np.float32) / 255
    img = np.asarray(Image.fromarray(dop).resize((n, n), Image.BILINEAR), np.float32)
    R, G, B = img[..., 0], img[..., 1], img[..., 2]
    bright = (R + G + B) / 3
    greenness = G - (R + B) / 2
    bare = np.clip((bright - 105) / 35, 0, 1) * np.clip((10 - greenness) / 12, 0, 1)
    sand = np.maximum(road, bare * 0.8)
    forest = forest * (1 - sand)
    grass = np.clip(1 - forest - sand, 0, 1)
    rgb = np.stack([grass, forest, sand], -1)
    im = Image.fromarray((rgb * 255).astype(np.uint8)).filter(ImageFilter.BoxBlur(2))
    im.save(os.path.join(out, "ground.png"), optimize=True)
    print("Bodenkarte", n, "x", n, "Anteile Rasen/Wald/Sand", rgb.reshape(-1, 3).mean(0).round(2))


def jet_local(p):
    return [round(p[0] + JETTY_REF[0] - E0, 2), round(p[1] - (JETTY_REF[1] - N0), 2)]


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
                os.path.join(a.cache, "dop_%d_%d_%d_%d.png" % (E0, N0, HALF, DOP_PX)))

    from pyproj import Transformer
    tr = Transformer.from_crs(25833, 4326, always_xy=True)
    w_, s_ = tr.transform(E0 - HALF, N0 - HALF)
    e_, n_ = tr.transform(E0 + HALF, N0 + HALF)
    osm = fetch(URLS["osm"].format(w=round(w_, 5), s=round(s_, 5), e=round(e_, 5), n=round(n_, 5)),
                os.path.join(a.cache, "osm_%d_%d_%d.xml" % (E0, N0, HALF)))

    n = build_terrain(dgm, a.out)
    terrain = (np.fromfile(os.path.join(a.out, "terrain.bin"), "<u2").reshape(n, n) / 100.0)
    with open(osm, "rb") as f:
        build_roads(f.read(), a.out)
    dop_img = build_dop(dop, a.out)
    with zipfile.ZipFile(lod2) as z:
        gml = z.read([nm for nm in z.namelist() if nm.lower().endswith(".gml")][0])
    footprints, house, bindex = build_buildings(gml, dop_img, a.out)
    build_trees(ndom, footprints, a.out)
    build_ground(dop_img, ndom, footprints, os.path.join(a.out, "roads.json"), a.out)

    meta = {
        "crs": "EPSG:25833", "origin": [E0, N0], "half": HALF, "base": BASE, "water": round(WATER - BASE, 2),
        "walk_radius": WALK_RADIUS,
        "terrain": {"n": n, "step": STEP, "scale": 0.01},
        "buildings": bindex,
        "jetties": [{"land": jet_local(l), "see": jet_local(w), "width": 1.3, "ours": k == OUR_JETTY}
                    for k, (l, w) in enumerate(JETTIES) if max(abs(v) for v in jet_local(w)) < HALF - 2],
        "house": dict(house or {"x": HOUSE_E - E0, "z": N0 - HOUSE_N, "top": None}, label="Am See 16"),
        "attribution": "© GeoBasis-DE/M-V 2026 (DGM1, nDOM, LoD2, DOP); Wege © OpenStreetMap-Mitwirkende (ODbL)",
    }
    with open(os.path.join(a.out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1, ensure_ascii=False)
    print("fertig:", meta["house"])


if __name__ == "__main__":
    main()
