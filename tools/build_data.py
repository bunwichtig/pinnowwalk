#!/usr/bin/env python3
"""Baut das Diorama von Am See 16, Pinnow (OT Godern), aus amtlichen Messdaten.

Alles im Modell stammt aus Messungen oder aus den eigenen Fotos, nichts ist erfunden:
  - Grundstücksgrenze: ALKIS-Flurstücke 111/90 und 111/91      (www.geodaten-mv.de/dienste/alkis_wms)
  - Gelände:           DGM1, 1 m                               (www.geodaten-mv.de/dienste/dgm_atom)
  - Gebäude:           LoD2 (echte Dachformen)                 (www.geodaten-mv.de/dienste/gebaeude_atom)
  - Bewuchs:           nDOM, Höhe über Gelände, 1 m             (www.geodaten-mv.de/dienste/ndom_atom)
  - Steg, Treppe, Terrasse, Vordach, Boot, Beet: nach den eigenen Fotos (Lage geschätzt)
Alle Geobasisdaten © GeoBasis-DE/M-V, frei nutzbar mit Quellenvermerk.

Aufruf:  python3 tools/build_data.py [--cache tools/cache]
"""
import argparse
import io
import json
import os
import re
import urllib.request
import zipfile

import mapbox_earcut as earcut
import numpy as np
import tifffile
from lxml import etree
from scipy.spatial import Delaunay
from shapely.geometry import LineString, MultiPoint, Point, Polygon
from shapely.ops import unary_union

E0, N0 = 270780.0, 5944840.0          # Ursprung des lokalen Systems (UTM 33N, EPSG:25833)
BASE = 27.0                           # m ü. NHN, entspricht y = 0
WATER = 27.75                         # Wasserspiegel Pinnower See laut DGM1
PARCELS = {"111/90": (270797.1, 5944829.1), "111/91": (270770.4, 5944848.1)}  # Abfragepunkt im Flurstück
TILE = "33_270_5944_2"
TILE_E, TILE_N = 270000, 5946000

# Nach den Fotos: Steg mit Badeleiter (im Luftbild der Steg vor 111/91), Betonstufen den Hang hinab,
# Terrasse mit Betonplatten und Wellblech-Vordach am Haus, umgedrehtes Boot und Beet am Steg.
JETTY = ((270744.0, 5944853.0), (270737.0, 5944859.0))   # Landseite -> Seeende, aus dem Luftbild
STAIR_TOP, STAIR_BOTTOM = (270782.0, 5944838.0), (270758.0, 5944853.0)

URLS = {
    "dgm": "https://www.geodaten-mv.de/dienste/dgm_download?index=4&dataset=ca268792-s2q1-4a39-b34c-9ec5bf9a4469&file=dgm1_{t}_gtiff.tif",
    "ndom": "https://www.geodaten-mv.de/dienste/ndom_download?index=0&dataset=66b85dc1-404c-4fab-b652-d2501962912c&file=ndom_{t}_gtiff.tif",
    "lod2": "https://www.geodaten-mv.de/dienste/gebaeude_download?index=0&dataset=8397b554-5cb9-4274-8be8-c20490d9a6e8&file=lod2_{t}_gml.zip",
    "alkis": "https://www.geodaten-mv.de/dienste/alkis_wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetFeatureInfo"
             "&LAYERS=adv_alkis_flurstuecke&QUERY_LAYERS=adv_alkis_flurstuecke&STYLES=&CRS=EPSG:25833"
             "&BBOX={x0},{y0},{x1},{y1}&WIDTH=3&HEIGHT=3&I=1&J=1&INFO_FORMAT=text/xml;subtype=gml/3.2.1&FEATURE_COUNT=1",
}
NS = {"gml": "http://www.opengis.net/gml", "bldg": "http://www.opengis.net/citygml/building/1.0"}


def fetch(url, path):
    if not os.path.exists(path):
        print("lade", url)
        req = urllib.request.Request(url, headers={"User-Agent": "pinnowwalk/0.2"})
        with urllib.request.urlopen(req, timeout=600) as r, open(path + ".part", "wb") as f:
            f.write(r.read())
        os.replace(path + ".part", path)
    return path


def loc(e, n):
    return round(float(e - E0), 2), round(float(N0 - n), 2)


def parcel_polygon(cache):
    polys = []
    for nr, (e, n) in PARCELS.items():
        path = fetch(URLS["alkis"].format(x0=e - 0.5, y0=n - 0.5, x1=e + 0.5, y1=n + 0.5),
                     os.path.join(cache, "flurstueck_%s.xml" % nr.replace("/", "_")))
        txt = open(path, encoding="utf-8").read()
        vals = re.findall(r"<gml:posList>([^<]+)", txt)[0].split()
        polys.append(Polygon(np.array(vals, float).reshape(-1, 2)))
    return unary_union(polys).buffer(0.01).buffer(-0.01)


def sampler(raster):
    # Pixel liegen als Flächen vor; bilinear zwischen den Pixelmitten
    def f(e, n):
        c = np.asarray(e) - TILE_E - 0.5
        r = TILE_N - np.asarray(n) - 0.5
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
        dc, dr = c - c0, r - r0
        v = lambda rr, cc: raster[rr, cc]
        return (v(r0, c0) * (1 - dc) * (1 - dr) + v(r0, c0 + 1) * dc * (1 - dr) +
                v(r0 + 1, c0) * (1 - dc) * dr + v(r0 + 1, c0 + 1) * dc * dr)
    return f


def surface(poly, h, step=1.0):
    """Dreiecksnetz des Geländes genau innerhalb der Grundstücksgrenze und die Seitenwände des Dioramas."""
    ring = LineString(poly.exterior.coords)
    edge = [ring.interpolate(d) for d in np.arange(0, ring.length, 0.75)]
    x0, y0, x1, y1 = poly.bounds
    shrunk = poly.buffer(-0.4)
    inner = [Point(x, y) for x in np.arange(x0, x1, step) for y in np.arange(y0, y1, step)]
    inner = [p for p in inner if shrunk.contains(p)]
    pts = np.array([[p.x, p.y] for p in edge + inner])
    tri = Delaunay(pts)
    keep = [t.tolist() for t in tri.simplices if poly.buffer(0.05).contains(Point(pts[t].mean(0)))]
    z = h(pts[:, 0], pts[:, 1])
    verts = []
    for (e, n), zz in zip(pts, z):
        x, zl = loc(e, n)
        verts.append([x, round(float(zz - BASE), 2), zl])
    bottom = round(float(z.min() - BASE - 1.5), 2)
    return {"verts": verts, "tris": keep, "edge": len(edge), "bottom": bottom}


def ring_points(ring):
    pl = ring.find("gml:posList", NS)
    vals = pl.text.split() if pl is not None else " ".join(p.text for p in ring.findall("gml:pos", NS)).split()
    pts = np.array(vals, float).reshape(-1, 3)
    return pts[:-1] if len(pts) > 1 and np.allclose(pts[0], pts[-1]) else pts


def triangulate(poly):
    rings = [ring_points(poly.find("gml:exterior/gml:LinearRing", NS))]
    rings += [ring_points(r) for r in poly.findall("gml:interior/gml:LinearRing", NS)]
    if len(rings[0]) < 3:
        return None
    allp = np.vstack(rings)
    nrm = np.zeros(3)
    for a, b in zip(rings[0], np.roll(rings[0], -1, axis=0)):
        nrm += [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]
    keep = [k for k in range(3) if k != int(np.argmax(np.abs(nrm)))]
    idx = earcut.triangulate_float64(allp[:, keep], np.cumsum([len(r) for r in rings]).astype(np.uint32))
    tris = allp[np.asarray(idx).reshape(-1, 3)]
    cr = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    flip = (cr @ nrm) < 0
    tris[flip] = tris[flip][:, ::-1]
    return tris


def buildings(gml, poly):
    out = []
    root = etree.parse(io.BytesIO(gml))
    for b in root.iter("{%s}Building" % NS["bldg"]):
        g = [ring_points(x.find("gml:exterior/gml:LinearRing", NS)) for x in b.findall(".//bldg:GroundSurface//gml:Polygon", NS)]
        if not g or not poly.contains(Point(np.vstack(g)[:, :2].mean(0))):
            continue
        parts = {}
        for kind, key in (("RoofSurface", "roof"), ("WallSurface", "wall")):
            tri = []
            for p in b.findall(".//bldg:%s//gml:Polygon" % kind, NS):
                t = triangulate(p)
                if t is not None:
                    for e, n, z in t.reshape(-1, 3):
                        x, zz = loc(e, n)
                        tri += [x, round(float(z - BASE), 2), zz]
            parts[key] = tri
        foot = [list(loc(e, n)) for e, n, _ in g[0]]
        out.append({"roof": parts["roof"], "wall": parts["wall"], "foot": foot,
                    "ground": round(float(np.vstack(g)[:, 2].min() - BASE), 2)})
    return out


def vegetation(ndom, poly, foot_polys, h):
    """Bewuchs aus dem nDOM als 1-m-Blöcke an der gemessenen Kronenoberfläche, Stämme an den Kronenspitzen."""
    x0, y0, x1, y1 = [int(v) for v in poly.bounds]
    houses = unary_union([Polygon(f) for f in foot_polys]).buffer(1.0) if foot_polys else Polygon()
    grid = {}
    for e in range(x0, x1 + 1):
        for n in range(y0, y1 + 1):
            ce, cn = e + 0.5, n + 0.5
            if not poly.contains(Point(ce, cn)) or houses.contains(Point(ce - E0, N0 - cn)):
                continue
            v = float(ndom[TILE_N - n - 1, e - TILE_E])
            if not np.isfinite(v) or v < 1.5 or v > 60:
                continue
            grid[(e, n)] = (v, float(h(ce, cn)))
    blocks, trunks = [], []
    for (e, n), (v, g) in grid.items():
        thick = float(np.clip(v * 0.35, 0.8, 4.0))
        x, z = loc(e + 0.5, n + 0.5)
        blocks.append([x, z, round(g + v - thick - BASE, 2), round(thick, 2), round(v, 1)])
        nb = [grid.get((e + dx, n + dy), (0, 0))[0] for dx in range(-2, 3) for dy in range(-2, 3)]
        if v >= 6 and v >= max(nb):
            trunks.append([x, z, round(g - BASE - 0.3, 2), round(g + v - thick - BASE + 0.5, 2), round(0.12 + v * 0.01, 2)])
    return blocks, trunks


def photo_objects(h, bld):
    hz = lambda e, n: round(float(h(e, n) - BASE), 2)
    objs = {}
    (le, ln), (we, wn) = JETTY
    objs["steg"] = {"land": list(loc(le, ln)), "see": list(loc(we, wn)), "width": 1.2, "y": round(WATER - BASE + 0.5, 2)}
    # Treppe: Betonstufen entlang der Linie oben -> unten, je 0,3 m Höhenunterschied eine Stufe
    steps, last = [], None
    line = LineString([STAIR_TOP, STAIR_BOTTOM])
    for d in np.arange(0, line.length, 0.25):
        p = line.interpolate(d)
        z = hz(p.x, p.y)
        if last is None or last - z >= 0.3:
            steps.append([*loc(p.x, p.y), z])
            last = z
    a = np.array(STAIR_BOTTOM) - np.array(STAIR_TOP)
    objs["treppe"] = {"steps": steps, "yaw": round(float(np.arctan2(-a[0], a[1])), 3), "width": 1.4}
    if bld:
        # Terrasse mit Vordach vor der Hauswand, die zum See zeigt
        foot = np.array(bld[0]["foot"])
        c = foot.mean(0)
        lake = np.array(loc(*STAIR_BOTTOM)) - c
        lake /= np.linalg.norm(lake)
        front = c + lake * ((foot @ lake).max() - c @ lake)
        tc = front + lake * 2.1
        objs["terrasse"] = {"x": round(float(tc[0]), 2), "z": round(float(tc[1]), 2),
                            "y": hz(E0 + tc[0], N0 - tc[1]), "w": 4.5, "d": 4.0,
                            "yaw": round(float(np.arctan2(lake[0], lake[1])), 3)}
        objs["vordach"] = dict(objs["terrasse"], h=2.4)
    objs["boot"] = {"x": loc(le + 6, ln - 1)[0], "z": loc(le + 6, ln - 1)[1], "y": hz(le + 6, ln - 1), "yaw": 0.8}
    objs["beet"] = {"x": loc(le + 9, ln - 4)[0], "z": loc(le + 9, ln - 4)[1], "y": hz(le + 9, ln - 4), "r": 1.6}
    return objs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "cache"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)

    dgm = tifffile.imread(fetch(URLS["dgm"].format(t=TILE), os.path.join(a.cache, "dgm1.tif")))
    ndom = tifffile.imread(fetch(URLS["ndom"].format(t=TILE), os.path.join(a.cache, "ndom.tif")))
    with zipfile.ZipFile(fetch(URLS["lod2"].format(t=TILE), os.path.join(a.cache, "lod2.zip"))) as z:
        gml = z.read([nm for nm in z.namelist() if nm.lower().endswith(".gml")][0])
    parcel = parcel_polygon(a.cache)
    h = sampler(dgm)
    # Das Grundstück endet ein paar Meter vor dem Wasser; der Uferstreifen bis zum Steg kommt dazu
    shore_pts = [p for p in parcel.exterior.coords if h(p[0], p[1]) < WATER + 1.0]
    strip = MultiPoint(shore_pts + [JETTY[0]]).convex_hull.buffer(2.0)
    poly = parcel.union(strip).buffer(0.01).buffer(-0.01)

    ground = surface(poly, h)
    bld = buildings(gml, parcel)
    blocks, trunks = vegetation(ndom, parcel, [b["foot"] for b in bld], h)
    objs = photo_objects(h, bld)
    # Wasserfläche vor dem Ufer, bis über das Stegende hinaus
    water = MultiPoint(shore_pts + [JETTY[0], JETTY[1]]).convex_hull.buffer(7).difference(poly)
    if water.geom_type != "Polygon":
        water = max(water.geoms, key=lambda g: g.area)

    model = {
        "crs": "EPSG:25833", "origin": [E0, N0], "base": BASE, "water": round(WATER - BASE, 2),
        "parcel": [list(loc(e, n)) for e, n in parcel.exterior.coords], "parcels": list(PARCELS),
        "area": [list(loc(e, n)) for e, n in poly.exterior.coords],
        "ground": ground, "buildings": bld, "vegetation": blocks, "trunks": trunks,
        "objects": objs, "waterArea": [list(loc(e, n)) for e, n in water.exterior.coords],
        "attribution": "© GeoBasis-DE/M-V 2026 (ALKIS, DGM1, nDOM, LoD2)",
    }
    with open(os.path.join(a.out, "model.json"), "w") as f:
        json.dump(model, f, separators=(",", ":"), ensure_ascii=False)
    print("Grundstück %.0f m², %d Geländedreiecke, %d Gebäude, %d Bewuchsblöcke, %d Stämme, %d Stufen" % (
        poly.area, len(ground["tris"]), len(bld), len(blocks), len(trunks), len(objs["treppe"]["steps"])))
    print(json.dumps(objs.get("terrasse")), objs["steg"])


if __name__ == "__main__":
    main()
