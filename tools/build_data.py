#!/usr/bin/env python3
"""Baut die Dioramen Am See 16 und Flurstück 111/89, Pinnow (OT Godern), aus amtlichen Messdaten.

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
from PIL import Image
from pyproj import Transformer
import numpy as np
import tifffile
from lxml import etree
from scipy.spatial import Delaunay
from shapely.geometry import LineString, MultiPoint, MultiPolygon, Point, Polygon
from shapely.ops import unary_union

E0, N0 = 270780.0, 5944840.0          # Ursprung des lokalen Systems (UTM 33N, EPSG:25833)
BASE = 27.0                           # m ü. NHN, entspricht y = 0
WATER = 27.75                         # Wasserspiegel Pinnower See laut DGM1
TILE = "33_270_5944_2"
TILE_E, TILE_N = 270000, 5946000

# Nach den Fotos: Steg mit Badeleiter (im Luftbild der Steg vor 111/91), Betonstufen den Hang hinab,
# Terrasse mit Betonplatten und Wellblech-Vordach am Haus, umgedrehtes Boot und Beet am Steg.
# Je Diorama: Ursprung, Flurstücke (Abfragepunkt im Flurstück), Steg (Landseite -> Seeende, aus dem Luftbild)
# und Treppe (oben -> unten). Steg, Treppe, Terrasse, Boot und Beet gibt es nur bei Am See 16.
SITES = {
    "am-see-16": {"title": "Am See 16", "sub": "Flurstücke 111/90 und 111/91", "origin": (270780.0, 5944840.0),
                  "parcels": {"111/90": (270797.1, 5944829.1), "111/91": (270770.4, 5944848.1)},
                  # Steg am Nordost-Ende des Ufers (im Luftbild sichtbar), Boot und Beet daneben
                  "jetty": ((270771.8, 5944868.5), (270762.3, 5944875.3)),
                  "stairs": ((270784.2, 5944841.2), (270761.0, 5944857.6)),
                  "boat": (270765.5, 5944858.0, 1.57), "bed": (270762.8, 5944863.7)},
    "am-see-89": {"title": "Flurstück 89", "sub": "Flurstück 111/89, schräg gegenüber", "origin": (270823.0, 5944872.0),
                  "parcels": {"111/89": (270823.3, 5944872.5)}, "jetty": None, "stairs": None},
    # Dorfstraße 2 (Pinnow-Dorf, Flurstück 56/4) mit allem im Umkreis von 100 m. Straßen aus OpenStreetMap,
    # Farben der Häuser und alles Weitere (Zaun, Laternen, Wartehäuschen, Terrasse, Wäschespinne) nach den Fotos.
    "dorfstrasse-2": {
        "title": "Dorfstraße 2", "sub": "Flurstück 56/4 und Umgebung, 100 m", "origin": (271563.0, 5944819.0),
        "parcels": {"56/4": (271563.3, 5944819.2)}, "jetty": None, "stairs": None, "radius": 100.0,
        # Hausteile nach den Fotos: Mitte und Nordostteil Backstein, Südwestteil verputzt mit Holzgiebel und Balkon,
        # davor ein niedriger Holzanbau mit bemoostem Dach; alle Hauptdächer rote Ziegel
        "colors": {"DEMVAL7600bsCoff": ("brick", "tile"), "DEMVAL7600bsCofr": ("brick", "tile"),
                   "DEMVAL7600bsCofa": ("plaster", "tile"), "DEMVAL7600bsCHwc": ("timber", "moss")},
        # Holzlattenzaun an der Straße zwischen Haus und Einmündung (Fotos von der Straße)
        "fences": [[(271548.3, 5944794.9), (271550.3, 5944797.4), (271556.0, 5944802.6)]],
        # Doppelkopf-Laternen: Gehwegecke an der Einmündung, Gehweg vor dem Haus (Fotos); OSM-Laterne im Osten
        "lamps": [(271556.0, 5944782.5), (271574.5, 5944815.5), (271642.0, 5944832.9)],
        # Wartehäuschen (grün, Glas) und Haltestellenschild laut OSM, Aussehen nach den Fotos
        # (das zweite Wartehäuschen aus OSM an der Einmündung ist auf den Fotos nicht zu sehen und fehlt deshalb)
        "shelters": [(271585.5, 5944820.6)],
        "busstops": [(271566.9, 5944805.9), (271583.8, 5944823.3)],
        # Garten nach den Fotos: Terrasse mit großen hellen Platten vor dem Backsteingiebel zum Garten,
        # zwei Holz-T-Pfosten mit Wäscheleinen etwa 9 m davor, etwas nach Nordost versetzt;
        # Holzbalkon im verputzten Giebel zur Einmündung (Südwest)
        "terrace": "DEMVAL7600bsCoff", "clothesline": 9.0, "balcony": "DEMVAL7600bsCofa",
    },
}
OSM_W = {"primary": 7, "secondary": 7, "tertiary": 6.5, "unclassified": 6, "residential": 6, "living_street": 5,
         "service": 3.5, "track": 3, "footway": 2, "path": 1.5, "cycleway": 2, "pedestrian": 3, "steps": 1.5}
PARCELS, JETTY, STAIRS, SITE = {}, None, None, {}

URLS = {
    "dgm": "https://www.geodaten-mv.de/dienste/dgm_download?index=4&dataset=ca268792-s2q1-4a39-b34c-9ec5bf9a4469&file=dgm1_{t}_gtiff.tif",
    "ndom": "https://www.geodaten-mv.de/dienste/ndom_download?index=0&dataset=66b85dc1-404c-4fab-b652-d2501962912c&file=ndom_{t}_gtiff.tif",
    "lod2": "https://www.geodaten-mv.de/dienste/gebaeude_download?index=0&dataset=8397b554-5cb9-4274-8be8-c20490d9a6e8&file=lod2_{t}_gml.zip",
    "osm": "https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}",
    "dop": "https://www.geodaten-mv.de/dienste/adv_dop?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=mv_dop&STYLES="
           "&CRS=EPSG:25833&BBOX={x0},{y0},{x1},{y1}&WIDTH={w}&HEIGHT={w}&FORMAT=image/jpeg",
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


def surface(poly, h, step=1.0, edge_step=0.75):
    """Dreiecksnetz des Geländes genau innerhalb der Grundstücksgrenze und die Seitenwände des Dioramas."""
    ring = LineString(poly.exterior.coords)
    edge = [ring.interpolate(d) for d in np.arange(0, ring.length, edge_step)]
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
        out.append({"id": b.get("{http://www.opengis.net/gml}id"), "roof": parts["roof"], "wall": parts["wall"], "foot": foot,
                    "ground": round(float(np.vstack(g)[:, 2].min() - BASE), 2), "_g": g[0][:, :2]})
    return out


def drape(poly, h, lift, step=1.5):
    """Flaches Band (Straße, Gehweg) als Dreiecksnetz knapp über dem Gelände, auch mit Löchern."""
    polys = list(poly.geoms) if isinstance(poly, MultiPolygon) else [poly]
    verts, tris = [], []
    for pg in polys:
        if pg.area < 0.5:
            continue
        pts = []
        for ring in [pg.exterior, *pg.interiors]:
            ls = LineString(ring.coords)
            pts += [ls.interpolate(d) for d in np.arange(0, ls.length, 1.0)]
        x0, y0, x1, y1 = pg.bounds
        sh = pg.buffer(-0.3)
        pts += [Point(x, y) for x in np.arange(x0, x1, step) for y in np.arange(y0, y1, step) if sh.contains(Point(x, y))]
        xy = np.array([[p.x, p.y] for p in pts])
        if len(xy) < 3:
            continue
        tri = Delaunay(xy)
        test = pg.buffer(0.02)
        off = len(verts)
        z = h(xy[:, 0], xy[:, 1])
        for (e, n), zz in zip(xy, z):
            x, zl = loc(e, n)
            verts.append([x, round(float(zz - BASE + lift), 2), zl])
        tris += [[int(k) + off for k in t] for t in tri.simplices if test.contains(Point(xy[t].mean(0)))]
    return {"verts": verts, "tris": tris}


def roof_colors(bld, dop, box):
    """Dachfarbe je Gebäude aus dem Luftbild, auf drei Töne vereinfacht (das Luftbild selbst wird nicht gezeigt)."""
    x0, y0, x1, y1 = box
    k = dop.shape[1] / (x1 - x0)
    for b in bld:
        pg = Polygon(b["_g"]).buffer(-0.6)
        if pg.is_empty:
            pg = Polygon(b["_g"])
        bx0, by0, bx1, by1 = pg.bounds
        vals = []
        for e in np.arange(bx0, bx1, 0.4):
            for n in np.arange(by0, by1, 0.4):
                if pg.contains(Point(e, n)):
                    c, r = int((e - x0) * k), int((y1 - n) * k)
                    if 0 <= r < dop.shape[0] and 0 <= c < dop.shape[1]:
                        vals.append(dop[r, c, :3])
        if not vals:
            b["roofTone"] = "grey"
            continue
        r, g, bl = np.median(np.array(vals, float), 0)
        b["roofTone"] = "tile" if r >= g + 15 and r >= bl + 15 else ("dark" if r + g + bl < 300 else "grey")


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


def trees_from_ndom(ndom, area, foot_polys, roads, h):
    """Einzelbäume aus dem nDOM: Kronenspitzen (lokale Maxima) als Baummitten, jede Bewuchszelle zur nächsten Spitze;
    daraus Kronenbreite, -höhe und -unterkante. Was zu niedrig oder zu klein für einen Baum ist, wird Busch/Hecke."""
    from scipy.ndimage import maximum_filter
    x0, y0, x1, y1 = [int(v) for v in area.bounds]
    c0, c1 = x0 - TILE_E, x1 - TILE_E
    r0, r1 = TILE_N - y1, TILE_N - y0
    sub = np.array(ndom[r0:r1, c0:c1], float)
    sub[~np.isfinite(sub) | (sub > 60)] = 0
    E = TILE_E + c0 + np.arange(sub.shape[1]) + 0.5
    N = TILE_N - r0 - np.arange(sub.shape[0]) - 0.5
    EE, NN = np.meshgrid(E, N)
    houses = unary_union([Polygon(f).buffer(0.8) for f in foot_polys]) if foot_polys else Polygon()
    from shapely import contains_xy
    mask = contains_xy(area, EE, NN) & ~contains_xy(houses, EE - E0, N0 - NN)
    mask &= ~(contains_xy(roads, EE, NN) & (sub < 4.0))      # Autos auf der Straße
    veg = mask & (sub >= 1.5)
    peaks = veg & (sub >= 4.0) & (sub == maximum_filter(sub, size=5))
    pr, pc = np.nonzero(peaks)
    # Zellen der nächsten Spitze zuordnen (höchstens 7 m entfernt, nicht höher als die Spitze)
    rr, cc = np.nonzero(veg)
    trees, bushes = [], []
    owner = -np.ones(len(rr), int)
    if len(pr):
        from scipy.spatial import cKDTree
        d, k = cKDTree(np.c_[pr, pc]).query(np.c_[rr, cc], distance_upper_bound=7.0)
        ok = np.isfinite(d) & (sub[rr, cc] >= 2.5)
        owner[ok] = k[ok]
    for t in range(len(pr)):
        sel = owner == t
        hs = sub[rr[sel], cc[sel]]
        top = float(sub[pr[t], pc[t]])
        if sel.sum() < 4:
            owner[sel] = -1
            continue
        ce, cn = float(E[cc[sel]].mean()), float(N[rr[sel]].mean())
        rad = float(np.clip(np.sqrt(sel.sum() / np.pi), 1.2, 9.0))
        bottom = float(np.clip(np.percentile(hs, 15) * 0.8, 1.2, top - 1.5))
        g = float(h(ce, cn))
        x, z = loc(ce, cn)
        trees.append([x, z, round(g - BASE, 2), round(bottom, 1), round(top, 1), round(rad, 1)])
    # Rest: Büsche und Hecken als 2-m-Klumpen
    rest = np.zeros_like(veg)
    rest[rr[owner < 0], cc[owner < 0]] = True
    for i in range(0, sub.shape[0] - 1, 2):
        for j in range(0, sub.shape[1] - 1, 2):
            w = rest[i:i + 2, j:j + 2]
            if w.sum() < 2:
                continue
            v = float(sub[i:i + 2, j:j + 2][w].max())
            ce, cn = float(E[j] + 0.5), float(N[i] - 0.5)
            x, z = loc(ce, cn)
            bushes.append([x, z, round(float(h(ce, cn)) - BASE, 2), round(min(v, 6.0), 1)])
    return trees, bushes


def ground_classes(verts, dop, box, road, foot):
    """Bodenart je Geländepunkt aus der Farbe des Luftbilds: 0 Rasen, 1 trockene Wiese, 2 Erde/Sand, 3 Pflaster.
    Nur die Klasse wird gespeichert, das Luftbild selbst nicht."""
    x0, y0, x1, y1 = box
    k = dop.shape[1] / (x1 - x0)
    out = []
    for x, _, z in verts:
        e, n = E0 + x, N0 - z
        c, r = int((e - x0) * k), int((y1 - n) * k)
        win = dop[max(0, r - 4):r + 5, max(0, c - 4):c + 5].reshape(-1, 3).astype(float)
        R, G, B = np.median(win, 0) if len(win) else (0, 0, 0)
        if G > R + 6 and G > B + 6:
            cls = 0 if G - R > 14 else 1
        elif abs(R - G) < 12 and abs(G - B) < 14 and R > 110:
            cls = 3
        elif R > G:
            cls = 2
        else:
            cls = 1
        out.append(cls)
    return out


def vegetation_coarse(ndom, area, parcel, foot_polys, roads, h):
    """Für den 100-m-Umkreis: im Flurstück 1-m-Blöcke wie bei den anderen Dioramen, außerhalb 2-m-Blöcke
    (höchster Wert der vier nDOM-Pixel), damit es auch auf dem Handy flüssig bleibt. Autos auf der Straße fallen weg."""
    houses = unary_union([Polygon(f).buffer(1.0) for f in foot_polys]) if foot_polys else Polygon()
    near_parcel = parcel.buffer(0.7)
    x0, y0, x1, y1 = [int(v) for v in area.bounds]
    blocks, cells = [], {}
    for size in (1, 2):
        for e in range(x0 - x0 % size, x1 + 1, size):
            for n in range(y0 - y0 % size, y1 + 1, size):
                ce, cn = e + size / 2, n + size / 2
                pt = Point(ce, cn)
                inside = near_parcel.contains(pt) if size == 2 else parcel.contains(pt)
                if (size == 1) != inside or not area.contains(pt) or houses.contains(Point(ce - E0, N0 - cn)):
                    continue
                win = ndom[TILE_N - n - size:TILE_N - n, e - TILE_E:e - TILE_E + size]
                win = win[np.isfinite(win) & (win < 60)]
                if not win.size:
                    continue
                v = float(win.max())
                if v < 1.8 or (v < 4.0 and roads.contains(pt)):
                    continue
                cells[(e, n, size)] = (v, float(h(ce, cn)))
    trunks = []
    for (e, n, size), (v, g) in cells.items():
        thick = float(np.clip(v * 0.35, 0.8, 4.0))
        x, z = loc(e + size / 2, n + size / 2)
        blocks.append([x, z, round(g + v - thick - BASE, 2), round(thick, 2), round(v, 1), size])
        nb = [cells.get((e + dx * size, n + dy * size, size), (0, 0))[0] for dx in range(-2, 3) for dy in range(-2, 3)]
        if v >= 6 and v >= max(nb):
            trunks.append([x, z, round(g - BASE - 0.3, 2), round(g + v - thick - BASE + 0.5, 2), round(0.12 + v * 0.01, 2)])
    return blocks, trunks


def osm_roads(cache, area):
    """Straßen und Wege aus OpenStreetMap als Flächen (Breite je Wegart)."""
    t = Transformer.from_crs(25833, 4326, always_xy=True)
    x0, y0, x1, y1 = area.buffer(30).bounds
    w, s_ = t.transform(x0, y0)
    e, n = t.transform(x1, y1)
    path = fetch(URLS["osm"].format(w=round(w, 5), s=round(s_, 5), e=round(e, 5), n=round(n, 5)),
                 os.path.join(cache, "osm_%d_%d.xml" % (E0, N0)))
    back = Transformer.from_crs(4326, 25833, always_xy=True)
    root = etree.parse(path)
    nodes = {nd.get("id"): back.transform(float(nd.get("lon")), float(nd.get("lat"))) for nd in root.iter("node")}
    road, foot, lines = [], [], []
    for way in root.iter("way"):
        tags = {x.get("k"): x.get("v") for x in way.iter("tag")}
        kind = tags.get("highway")
        if kind not in OSM_W or tags.get("area") == "yes":
            continue
        ls = LineString([nodes[nd.get("ref")] for nd in way.iter("nd") if nd.get("ref") in nodes])
        (foot if kind in ("footway", "path", "cycleway", "steps") else road).append(ls.buffer(OSM_W[kind] / 2, cap_style=2 if kind in ("footway", "path") else 1))
        if kind not in ("footway", "path", "cycleway", "steps", "service"):
            lines.append(ls)
    clip = area.buffer(-0.3)
    road = unary_union(road).intersection(clip) if road else Polygon()
    foot = unary_union(foot).difference(road).intersection(clip) if foot else Polygon()
    return road, foot, lines


def street_objects(h, bld, parcel, road, lines):
    """Zaun, Laternen, Wartehäuschen, Haltestellenschilder, Terrasse und Wäscheleine nach den Fotos (Lage geschätzt)."""
    hz = lambda e, n: round(float(h(e, n) - BASE), 2)
    pt = lambda e, n: [*loc(e, n), hz(e, n)]
    objs = {}
    houses = unary_union([Polygon(b["_g"]) for b in bld]).buffer(0.3)
    fences = []
    for line in SITE.get("fences", []):
        rest = LineString(line).difference(houses)
        for seg in (rest.geoms if hasattr(rest, "geoms") else [rest]):
            if seg.length < 1:
                continue
            dense = [seg.interpolate(d) for d in np.arange(0, seg.length, 2.0)] + [Point(seg.coords[-1])]
            fences.append([pt(p.x, p.y) for p in dense])
    objs["zaun"] = fences
    objs["laternen"] = [pt(e, n) for e, n in SITE.get("lamps", [])]

    def road_yaw(e, n):
        # Richtung der nächsten Straße, damit Wartehäuschen parallel dazu stehen
        p = Point(e, n)
        ln = min(lines, key=lambda l: l.distance(p))
        d = ln.project(p)
        a, b = ln.interpolate(max(0, d - 2)), ln.interpolate(min(ln.length, d + 2))
        side = ln.interpolate(d)
        # lokale Achsen: x = Ost, z = Süd; Rückwand zeigt von der Straße weg
        nx, nz = e - side.x, -(n - side.y)
        return round(float(np.arctan2(b.x - a.x, -(b.y - a.y))), 3), round(float(np.arctan2(nx, nz)), 3)
    objs["haeuschen"] = [[*pt(e, n), *road_yaw(e, n)] for e, n in SITE.get("shelters", [])]
    objs["haltestellen"] = [pt(e, n) for e, n in SITE.get("busstops", [])]

    # Terrasse vor der Gartenseite des Haupthauses: die Wand, die am weitesten in den Garten (Nordwest) zeigt
    def facing(bid, want, gable=False):
        """Mitte, Außennormale, Tangente und Länge der Wand eines Gebäudes, die am ehesten in Richtung `want` zeigt;
        mit gable=True nur Giebelwände (quer zum First)."""
        b = next((b for b in bld if b["id"] == bid), None)
        if b is None:
            return None
        g = b["_g"]
        c = g.mean(0)
        ridge = None
        if gable:
            r = np.array(b["roof"]).reshape(-1, 3)
            top = r[r[:, 1] > r[:, 1].max() - 0.15]
            d = np.array([top[:, 0], -top[:, 2]]).T          # zurück nach Ost/Nord
            d = d - d.mean(0)
            ridge = np.linalg.svd(d)[2][0]
        best = None
        for p0, p1 in zip(g, np.roll(g, -1, axis=0)):
            t = p1 - p0
            L = float(np.hypot(*t))
            if L < 3:
                continue
            nrm = np.array([t[1], -t[0]]) / L
            if np.dot(nrm, (p0 + p1) / 2 - c) < 0:
                nrm = -nrm
            if ridge is not None and abs(np.dot(nrm, ridge)) < 0.8:
                continue
            if best is None or np.dot(nrm, want) > best[0]:
                best = (np.dot(nrm, want), (p0 + p1) / 2, nrm, t / L, L, b)
        return best[1:]

    side = facing(SITE.get("balcony"), [-0.7071, -0.7071], gable=True)   # Giebel zur Straßenecke
    if side:
        mid, nrm, tan, L, b = side
        bc = mid + nrm * 0.45
        objs["balkon"] = {"x": loc(*bc)[0], "z": loc(*bc)[1], "y": round(b["ground"] + 3.0, 2), "w": round(min(5.5, L - 1.2), 2),
                          "d": 0.9, "yaw": round(float(np.arctan2(nrm[0], -nrm[1])), 3)}
    main = facing(SITE.get("terrace"), [-0.7071, 0.7071])           # Gartenseite nach Nordwest
    if main is not None:
        mid, nrm, tan, L, _ = main
        if np.dot(tan, [0.7071, 0.7071]) < 0:                # Tangente zeigt nach Nordost
            tan = -tan
        tc = mid + nrm * 1.9
        lx, lz = loc(*tc)
        yaw = round(float(np.arctan2(nrm[0], -nrm[1])), 3)
        objs["platten"] = {"x": lx, "z": lz, "y": hz(*tc), "w": round(min(5.0, L - 0.5), 2), "d": 3.6, "yaw": yaw}
        cl = mid + nrm * SITE.get("clothesline", 9.0) + tan * 2.0
        objs["waesche"] = {"a": pt(*(cl - tan * 2.3)), "b": pt(*(cl + tan * 2.3)), "h": 2.0}
    return objs


def photo_objects(h, bld):
    hz = lambda e, n: round(float(h(e, n) - BASE), 2)
    objs = {}
    if JETTY is None:
        return objs
    STAIR_TOP, STAIR_BOTTOM = STAIRS
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
    be, bn, byaw = SITE["boat"]
    objs["boot"] = {"x": loc(be, bn)[0], "z": loc(be, bn)[1], "y": hz(be, bn), "yaw": byaw}
    ee, en = SITE["bed"]
    objs["beet"] = {"x": loc(ee, en)[0], "z": loc(ee, en)[1], "y": hz(ee, en), "r": 1.6}
    return objs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "cache"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    ap.add_argument("--only", help="nur dieses Diorama bauen, z. B. dorfstrasse-2")
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    os.makedirs(a.out, exist_ok=True)

    dgm = tifffile.imread(fetch(URLS["dgm"].format(t=TILE), os.path.join(a.cache, "dgm1.tif")))
    ndom = tifffile.imread(fetch(URLS["ndom"].format(t=TILE), os.path.join(a.cache, "ndom.tif")))
    with zipfile.ZipFile(fetch(URLS["lod2"].format(t=TILE), os.path.join(a.cache, "lod2.zip"))) as z:
        gml = z.read([nm for nm in z.namelist() if nm.lower().endswith(".gml")][0])
    h = sampler(dgm)
    for key, site in SITES.items():
        if a.only and key != a.only:
            continue
        build_site(key, site, a, h, ndom, gml)


def build_site(key, site, a, h, ndom, gml):
    global E0, N0, PARCELS, JETTY, STAIRS, SITE
    SITE = site
    E0, N0 = site["origin"]
    PARCELS, JETTY, STAIRS = site["parcels"], site["jetty"], site["stairs"]
    parcel = parcel_polygon(a.cache)
    # Das Grundstück endet ein paar Meter vor dem Wasser; der Uferstreifen bis zum Steg kommt dazu
    shore_pts = [p for p in parcel.exterior.coords if h(p[0], p[1]) < WATER + 1.0]
    poly, water = parcel, None
    if JETTY:
        strip = MultiPoint(shore_pts + [JETTY[0]]).convex_hull.buffer(2.0)
        poly = parcel.union(strip).buffer(0.01).buffer(-0.01)
        # Wasserfläche vor dem Ufer, bis über das Stegende hinaus
        water = MultiPoint(shore_pts + [JETTY[0], JETTY[1]]).convex_hull.buffer(7).difference(poly)
        if water.geom_type != "Polygon":
            water = max(water.geoms, key=lambda g: g.area)

    extra = {}
    if site.get("radius"):
        # Umkreis statt Grundstück: alles im Kreis um das Haus, das Flurstück wird nur markiert
        poly = Point(E0, N0).buffer(site["radius"], 48)
        ground = surface(poly, h, step=2.0, edge_step=2.0)
        bld = buildings(gml, poly)
        r = site["radius"] + 2
        box = (E0 - r, N0 - r, E0 + r, N0 + r)
        px = int(2 * r / 0.25)
        dop = np.asarray(Image.open(fetch(URLS["dop"].format(x0=box[0], y0=box[1], x1=box[2], y1=box[3], w=px),
                                          os.path.join(a.cache, "dop_%d_%d.jpg" % (E0, N0)))).convert("RGB"))
        roof_colors(bld, dop, box)
        for b in bld:
            b["main"] = parcel.contains(Point(b["_g"].mean(0)))
            if b["id"] in site.get("colors", {}):
                b["wallTone"], b["roofTone"] = site["colors"][b["id"]]
        road, foot, lines = osm_roads(a.cache, poly)
        side = road.buffer(2.6).difference(road).intersection(parcel.buffer(5)).difference(
            unary_union([Polygon(b["_g"]) for b in bld])).intersection(poly.buffer(-0.3))
        foot = unary_union([foot, side])
        blocks, trunks = [], []
        trees, bushes = trees_from_ndom(ndom, poly, [b["foot"] for b in bld], unary_union([road, foot]), h)
        ground["cls"] = ground_classes(ground["verts"], dop, box, road, foot)
        objs = street_objects(h, bld, parcel, road, lines)
        extra = {"trees": trees, "bushes": bushes, "roads": drape(road, h, 0.06), "walks": drape(foot, h, 0.1), "radius": site["radius"],
                 "attributionOsm": "Straßen © OpenStreetMap-Mitwirkende (ODbL)"}
    else:
        ground = surface(poly, h)
        bld = buildings(gml, parcel)
        blocks, trunks = vegetation(ndom, parcel, [b["foot"] for b in bld], h)
        objs = photo_objects(h, bld)
    for b in bld:
        del b["_g"]

    model = {
        "title": site["title"], "subtitle": site["sub"],
        "crs": "EPSG:25833", "origin": [E0, N0], "base": BASE, "water": round(WATER - BASE, 2),
        "parcel": [list(loc(e, n)) for e, n in parcel.exterior.coords], "parcels": list(PARCELS),
        "area": [list(loc(e, n)) for e, n in poly.exterior.coords],
        "ground": ground, "buildings": bld, "vegetation": blocks, "trunks": trunks,
        "objects": objs, "waterArea": [list(loc(e, n)) for e, n in water.exterior.coords] if water else [],
        "attribution": "© GeoBasis-DE/M-V 2026 (ALKIS, DGM1, nDOM, LoD2)", **extra,
    }
    with open(os.path.join(a.out, key + ".json"), "w") as f:
        json.dump(model, f, separators=(",", ":"), ensure_ascii=False)
    print("%s: Grundstück %.0f m², %d Geländedreiecke, %d Gebäude, %d Bewuchsblöcke, %d Stämme" % (
        key, poly.area, len(ground["tris"]), len(bld), len(blocks), len(trunks)))


if __name__ == "__main__":
    main()
