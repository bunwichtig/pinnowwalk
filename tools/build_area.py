#!/usr/bin/env python3
"""Baut das Modell "Am See 16 mit 100 m Umgebung" aus amtlichen Messdaten.

  - Gelände:       DGM1, 1-m-Raster                       (www.geodaten-mv.de/dienste/dgm_atom)
  - Gebäude:       LoD2 mit echten Dachformen             (www.geodaten-mv.de/dienste/gebaeude_atom)
  - Bäume:         Kronenspitzen und Kronenbreite aus dem nDOM (www.geodaten-mv.de/dienste/ndom_atom)
  - Grenzen:       ALKIS-Flurstücke 111/89, 111/90, 111/91
  - Weg "Am See":  OpenStreetMap (ODbL)
  - Steg, Treppe, Terrasse, Boot, Beet: aus data/am-see-16.json (nach den eigenen Fotos)
Geobasisdaten © GeoBasis-DE/M-V, frei nutzbar mit Quellenvermerk; Wege © OpenStreetMap-Mitwirkende.

Aufruf:  python3 tools/build_area.py [--cache tools/cache]
"""
import argparse
import colorsys
import hashlib
import json
import os
import zipfile

import numpy as np
import pyproj
import tifffile
from lxml import etree
from PIL import Image
from scipy import ndimage
from shapely.geometry import LineString, Point, Polygon

import build_data as bd

CE, CN = 270794.0, 5944834.0      # Mitte: Haus Am See 16 (EPSG:25833)
R = 100                           # Radius der Umgebung in m
OWN = "DEMVAL7600bsCmDq"          # Haus Am See 16 im LoD2
WALLS = ["cream", "cream", "creamlight", "salmon", "white"]   # Wohnhäuser laut Fotos
OSM = "https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.path.dirname(__file__), "cache"))
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data"))
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    bd.E0, bd.N0 = CE, CN
    loc = bd.loc

    dgm = tifffile.imread(bd.fetch(bd.URLS["dgm"].format(t=bd.TILE), os.path.join(a.cache, "dgm1.tif")))
    ndom = tifffile.imread(bd.fetch(bd.URLS["ndom"].format(t=bd.TILE), os.path.join(a.cache, "ndom.tif"))).astype(float)
    ndom[~np.isfinite(ndom) | (ndom > 60) | (ndom < 0)] = 0
    with zipfile.ZipFile(bd.fetch(bd.URLS["lod2"].format(t=bd.TILE), os.path.join(a.cache, "lod2.zip"))) as z:
        gml = z.read([nm for nm in z.namelist() if nm.lower().endswith(".gml")][0])
    h = bd.sampler(dgm)

    # ---- Gelände: Höhen auf dem 1-m-Raster, Raster (2R+1)², Zeile = Süd -> Nord umgedreht (z wächst nach Süden)
    xs = np.arange(-R, R + 1)
    E, N = np.meshgrid(CE + xs, CN - xs)              # [zeile=z, spalte=x]
    H = h(E, N)
    col = (E - bd.TILE_E).astype(int)
    row = (bd.TILE_N - N).astype(int)
    canopy = ndom[np.clip(row, 0, ndom.shape[0] - 1), np.clip(col, 0, ndom.shape[1] - 1)]

    # Luftbild (nur zum Ableiten von Farben, wird nicht gezeigt): 25 cm je Pixel
    box = (CE - R - 2, CN - R - 2, CE + R + 2, CN + R + 2)
    px = int((box[2] - box[0]) * 4)
    dop = np.asarray(Image.open(bd.fetch(bd.URLS["dop"].format(x0=box[0], y0=box[1], x1=box[2], y1=box[3], w=px),
                                         os.path.join(a.cache, "dop_area_%d_%d.jpg" % (CE, CN)))).convert("RGB"), float)
    dop1 = ndimage.uniform_filter(dop, (5, 5, 1))                    # Mittel über gut 1 m
    pc = np.clip(((E - box[0]) * 4).astype(int), 0, px - 1)
    pr = np.clip(((box[3] - N) * 4).astype(int), 0, px - 1)
    rgb = dop1[pr, pc]                                              # Farbe je Rasterpunkt
    exg = 2 * rgb[..., 1] - rgb[..., 0] - rgb[..., 2]               # "Grünheit"
    bright = rgb.sum(-1)

    # Bodenart je Rasterpunkt: w Wasser, s Ufersand, f Waldboden (unter Kronen), g Wiese, d trockene Wiese,
    # b offener Boden (Baustelle auf der 89, laut Fotos), r Sandweg
    cover = np.full(H.shape, "d", dtype="<U1")
    cover[exg > 14] = "g"
    cover[(exg < 4) & (rgb[..., 0] > rgb[..., 2] + 12) & (bright > 300)] = "b"
    shade = ndimage.uniform_filter((canopy > 3).astype(float), 5)
    cover[shade > 0.5] = "f"
    # Im DGM ist der See eine ebene Fläche auf Spiegelhöhe; zum Ufer hin flacher Grund, weiter draußen tiefer
    lake = ndimage.binary_opening(H < bd.WATER + 0.05, iterations=1)
    cover[(H < bd.WATER + 0.45) & ~lake] = "s"
    cover[lake] = "w"
    dist = ndimage.distance_transform_edt(lake)
    H = np.where(lake, bd.WATER - 0.15 - np.minimum(2.5, dist * 0.18), H)

    # Flurstücke aus den bisherigen Dioramen, dazu die Dinge von den Fotos
    parcels = {}
    for nr, key in (("16", "am-see-16"), ("89", "am-see-89")):
        m = json.load(open(os.path.join(a.out, key + ".json")))
        ox, oz = m["origin"][0] - CE, CN - m["origin"][1]
        parcels[nr] = [[round(x + ox, 2), round(z + oz, 2)] for x, z in m["parcel"]]
        if nr == "16":
            objs = shift(m["objects"], ox, oz)
    p16, p89 = Polygon(parcels["16"]), Polygon(parcels["89"])
    gx, gz = np.meshgrid(xs, xs)
    in89 = np.array([[p89.contains(Point(x, z)) for x in xs] for z in xs])
    cover[in89 & (shade <= 0.5)] = "b"                              # Baustelle (Fotos K, N, O)

    # Weg "Am See" aus OSM
    tr = pyproj.Transformer.from_crs(4326, 25833, always_xy=True)
    inv = pyproj.Transformer.from_crs(25833, 4326, always_xy=True)
    w_, s_ = inv.transform(CE - R - 10, CN - R - 10)
    e_, n_ = inv.transform(CE + R + 10, CN + R + 10)
    osm = etree.parse(bd.fetch(OSM.format(w=round(w_, 5), s=round(s_, 5), e=round(e_, 5), n=round(n_, 5)),
                               os.path.join(a.cache, "osm_area_%d.xml" % R)))
    nodes = {n.get("id"): tr.transform(float(n.get("lon")), float(n.get("lat"))) for n in osm.iter("node")}
    roads, lines = [], []
    for way in osm.iter("way"):
        tags = {t.get("k"): t.get("v") for t in way.findall("tag")}
        if "highway" in tags:
            pts = [nodes[nd.get("ref")] for nd in way.findall("nd") if nd.get("ref") in nodes]
            if len(pts) > 1:
                lines.append(LineString([loc(*q) for q in pts]))
                roads.append(LineString(pts).buffer(2.2 if tags["highway"] == "residential" else 1.6))
    for rd in roads:
        x0, y0, x1, y1 = rd.bounds
        for r_, c_ in zip(*np.nonzero((E >= x0) & (E <= x1) & (N >= y0) & (N <= y1))):
            if cover[r_, c_] not in "ws" and rd.contains(Point(E[r_, c_], N[r_, c_])):
                cover[r_, c_] = "r"
    inside = (xs[None, :] ** 2 + xs[:, None] ** 2) <= R * R
    cover[~inside] = "-"

    # ---- Gebäude: alle LoD2-Gebäude im Kreis. Dachfarbe aus dem Luftbild (Median der Dachfläche),
    # Wände nach den Fotos: das eigene Haus dunkelbraunes Holz, Wohnhäuser cremegelbe Holzverschalung,
    # kleine Schuppen und Lauben dunkelbraune Bretter
    circle = Point(CE, CN).buffer(R - 1, 64)
    raw = bd.buildings(gml, circle)
    bld = []
    for b in raw:
        g = Polygon(b["_g"])
        pg = g.buffer(-0.6) if g.buffer(-0.6).area > 2 else g
        x0, y0, x1, y1 = pg.bounds
        vals = [dop[int((box[3] - n) * 4), int((e - box[0]) * 4)] for e in np.arange(x0, x1, 0.3)
                for n in np.arange(y0, y1, 0.3) if pg.contains(Point(e, n))]
        roof = np.median(vals, 0) if vals else np.array([110, 110, 112])
        roof = np.clip(roof * 1.15 + 8, 0, 255)                     # Luftbild ist etwas dunkel
        area = g.area
        height = max(b["roof"][1::3]) - b["ground"]
        if b["id"] == OWN:
            wall = "ownwood"
        elif area < 30 or height < 3.6:
            wall = "shed"
        else:
            wall = WALLS[int(hashlib.md5(b["id"].encode()).hexdigest(), 16) % len(WALLS)]
        b = {k: v for k, v in b.items() if not k.startswith("_")}
        b["roofRGB"] = "#%02x%02x%02x" % tuple(int(v) for v in roof)
        if b["id"] == OWN:
            b["roofRGB"] = "#4f5452"      # dunkle Schindeln laut Fotos (im Luftbild vom Kiefernschatten verdeckt)
        b["wallTone"] = wall
        b["own"] = b["id"] == OWN
        bld.append(b)
    houses = [Polygon(b["foot"]).buffer(0.8) for b in bld]
    house_mask = np.array([[any(p.contains(Point(x, z)) for p in houses) for x in xs] for z in xs])

    # ---- Bewuchs aus dem nDOM als Blöcke an der gemessenen Kronenoberfläche (wie bei der Dorfstraße 2):
    # 1-m-Blöcke auf den beiden Grundstücken und nahe am Haus, sonst 2-m-Blöcke. Jeder Block gehört zu einem Baum
    # (Wasserscheide um die Kronenspitzen) und bekommt dessen Farbe aus dem Luftbild.
    sub = ndom[row.min():row.max() + 1, col.min():col.max() + 1]   # gleiche Ausrichtung wie das Raster
    sm = ndimage.gaussian_filter(sub, 0.8)
    peaks = (sm == ndimage.maximum_filter(sm, size=5)) & (sm >= 3.5) & inside & ~house_mask
    markers, npk = ndimage.label(peaks)
    seg = ndimage.watershed_ift((255 - np.clip(sm * 8, 0, 255)).astype(np.uint8), markers.astype(np.int32))
    seg[sm < 1.5] = 0
    tree_col = {}
    for t in range(1, npk + 1):
        m_ = seg == t
        if not m_.any():
            continue
        c = rgb[m_].mean(0)
        hh, ss, vv = colorsys.rgb_to_hsv(*(c / 255))
        # Farbton aus dem Luftbild, Sättigung und Helligkeit auf ein ruhiges Maß gebracht
        r_, g_, b_ = colorsys.hsv_to_rgb(min(max(hh, 0.17), 0.33), float(np.clip(ss * 1.05, 0.3, 0.55)), float(np.clip(vv * 1.7, 0.42, 0.62)))
        tree_col[t] = "#%02x%02x%02x" % (int(r_ * 255), int(g_ * 255), int(b_ * 255))
    near = (gx ** 2 + gz ** 2 <= 35 ** 2) | np.array([[p16.buffer(3).contains(Point(x, z)) or p89.buffer(3).contains(Point(x, z))
                                                      for x in xs] for z in xs])
    blocks = []
    for size in (1, 2):
        for j in range(0, 2 * R, size):
            for i in range(0, 2 * R, size):
                if near[j, i] != (size == 1) or not inside[j, i] or (i - R) ** 2 + (j - R) ** 2 > (R - 1.5) ** 2:
                    continue
                win = sub[j:j + size, i:i + size]
                v = float(win.max())
                if v < 1.8 or house_mask[j, i] or lake[j, i] or (v < 4 and cover[j, i] == "r"):
                    continue
                ci, cj = i + size / 2 - 0.5, j + size / 2 - 0.5
                g = float(H[j, i]) - bd.BASE
                thick = float(np.clip(v * 0.33, 0.8, 5.0))
                t = int(seg[j:j + size, i:i + size].max())
                blocks.append([round(ci - R, 1), round(cj - R, 1), round(g + v - thick, 2), round(thick, 2), size,
                               t if t in tree_col else 0])
    # Stämme an den Kronenspitzen; Kiefern unten graubraun, oben orange (Fotos B, F)
    trunks = []
    for t in range(1, npk + 1):
        jj, ii = np.argwhere(markers == t)[0]
        top = float(sub[jj, ii])
        if top < 6:
            continue
        g = float(H[jj, ii]) - bd.BASE
        trunks.append([float(xs[ii]), float(xs[jj]), round(g - 0.3, 2), round(g + top * 0.72, 2), round(0.12 + top * 0.009, 2)])

    # ---- Schilf am Ufer: grünliche Stellen im flachen Wasser (Fotos D, J)
    reeds = [[float(xs[i]), float(xs[j])] for j, i in zip(*np.nonzero(lake & (dist <= 4) & (exg > 6) & inside))]

    # ---- Zäune nach den Fotos: Lattenzaun (diagonal) zur Straße, Bretterzaun zum Nachbarn im Nordosten
    ring = parcels["16"][:-1]
    edges = [(ring[k], ring[(k + 1) % len(ring)]) for k in range(len(ring)) if ring[k] != ring[(k + 1) % len(ring)]]
    road_line = min(lines, key=lambda l: l.distance(Point(0, 0))) if lines else None
    def mid(e): return Point((e[0][0] + e[1][0]) / 2, (e[0][1] + e[1][1]) / 2)
    front = min(edges, key=lambda e: road_line.distance(mid(e))) if road_line else None
    fences = []
    if front:
        fences.append({"kind": "latte", "pts": dense(front, H, xs)})
    # Grenze zum Nachbarn: die lange Kante, die dem Haus am nächsten liegt, ab der Straßenecke 22 m Richtung See
    own_c = Polygon(next(b["foot"] for b in bld if b["own"])).centroid
    longs = sorted([e for e in edges if e is not front], key=lambda e: LineString(e).distance(own_c))
    if longs:
        e = longs[0]
        ln = LineString(e)
        cut = LineString([ln.interpolate(max(0, ln.length - 22)).coords[0], e[1]]) if ln.length > 22 else ln
        fences.append({"kind": "brett", "pts": dense(list(cut.coords), H, xs)})

    model = {
        "crs": "EPSG:25833", "origin": [CE, CN], "base": bd.BASE, "water": round(bd.WATER - bd.BASE, 2), "radius": R,
        "heights": [int(round((v - bd.BASE) * 100)) for v in H.ravel()], "cover": "".join(cover.ravel()),
        "buildings": bld, "blocks": blocks, "treeColors": {str(k): v for k, v in tree_col.items()}, "trunks": trunks,
        "reeds": reeds, "fences": fences, "parcels": parcels, "objects": objs,
        "attribution": "© GeoBasis-DE/M-V 2026 (ALKIS, DGM1, nDOM, LoD2, DOP), © OpenStreetMap-Mitwirkende",
    }
    with open(os.path.join(a.out, "umgebung.json"), "w") as f:
        json.dump(model, f, separators=(",", ":"), ensure_ascii=False)
    print("%d Gebäude, %d Bäume, %d Blöcke, %d Stämme, %d Schilf, %d Zäune" % (
        len(bld), len(tree_col), len(blocks), len(trunks), len(reeds), len(fences)))


def dense(edge, H, xs, step=2.0):
    """Zaunlinie alle 2 m mit Geländehöhe."""
    ln = LineString(edge)
    out = []
    for d in list(np.arange(0, ln.length, step)) + [ln.length]:
        p = ln.interpolate(d)
        i, j = int(round(p.x)) + R, int(round(p.y)) + R
        out.append([round(p.x, 2), round(p.y, 2), round(float(H[j, i]) - bd.BASE, 2)])
    return out

def shift(o, ox, oz):
    """Lokale Koordinaten aus dem Diorama in das Umgebungsmodell verschieben."""
    if isinstance(o, dict):
        out = {}
        for k, v in o.items():
            if k in ("x",):
                out[k] = round(v + ox, 2)
            elif k in ("z",):
                out[k] = round(v + oz, 2)
            elif k in ("land", "see"):
                out[k] = [round(v[0] + ox, 2), round(v[1] + oz, 2)]
            elif k == "steps":
                out[k] = [[round(s[0] + ox, 2), round(s[1] + oz, 2), s[2]] for s in v]
            else:
                out[k] = shift(v, ox, oz)
        return out
    return o


if __name__ == "__main__":
    main()
