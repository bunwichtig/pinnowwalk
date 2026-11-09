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
import json
import os
import zipfile

import numpy as np
import pyproj
import tifffile
from lxml import etree
from scipy import ndimage
from shapely.geometry import LineString, Point, Polygon

import build_data as bd

CE, CN = 270794.0, 5944834.0      # Mitte: Haus Am See 16 (EPSG:25833)
R = 100                           # Radius der Umgebung in m
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

    # Bodenart je Rasterpunkt: w Wasser, s Ufer, f Waldboden (unter Bäumen), g Wiese, r Weg
    cover = np.full(H.shape, "g", dtype="<U1")
    shade = ndimage.uniform_filter((canopy > 3).astype(float), 5)
    cover[shade > 0.5] = "f"
    # Im DGM ist der See eine ebene Fläche auf Spiegelhöhe; zum Ufer hin flacher Grund, weiter draußen tiefer
    lake = ndimage.binary_opening(H < bd.WATER + 0.05, iterations=1)
    cover[(H < bd.WATER + 0.45) & ~lake] = "s"
    cover[lake] = "w"
    dist = ndimage.distance_transform_edt(lake)
    H = np.where(lake, bd.WATER - 0.15 - np.minimum(2.5, dist * 0.18), H)

    # Weg "Am See" aus OSM
    tr = pyproj.Transformer.from_crs(4326, 25833, always_xy=True)
    inv = pyproj.Transformer.from_crs(25833, 4326, always_xy=True)
    w_, s_ = inv.transform(CE - R - 10, CN - R - 10)
    e_, n_ = inv.transform(CE + R + 10, CN + R + 10)
    osm = etree.parse(bd.fetch(OSM.format(w=round(w_, 5), s=round(s_, 5), e=round(e_, 5), n=round(n_, 5)),
                               os.path.join(a.cache, "osm_area_%d.xml" % R)))
    nodes = {n.get("id"): tr.transform(float(n.get("lon")), float(n.get("lat"))) for n in osm.iter("node")}
    roads = []
    for way in osm.iter("way"):
        tags = {t.get("k"): t.get("v") for t in way.findall("tag")}
        if "highway" in tags:
            pts = [nodes[nd.get("ref")] for nd in way.findall("nd") if nd.get("ref") in nodes]
            if len(pts) > 1:
                roads.append(LineString(pts).buffer(2.2 if tags["highway"] == "residential" else 1.6))
    for rd in roads:
        x0, y0, x1, y1 = rd.bounds
        for r_, c_ in zip(*np.nonzero((E >= x0) & (E <= x1) & (N >= y0) & (N <= y1))):
            if cover[r_, c_] not in "ws" and rd.contains(Point(E[r_, c_], N[r_, c_])):
                cover[r_, c_] = "r"
    inside = (xs[None, :] ** 2 + xs[:, None] ** 2) <= R * R
    cover[~inside] = "-"

    # ---- Gebäude: alle LoD2-Gebäude, deren Mitte im Kreis liegt
    circle = Point(CE, CN).buffer(R - 1, 64)
    bld = [{k: v for k, v in b.items() if not k.startswith("_")} for b in bd.buildings(gml, circle)]
    houses = [Polygon(b["foot"]) for b in bld]

    # ---- Bäume: Kronenspitzen im geglätteten nDOM, Kronenbreite dort, wo die Höhe auf 60 % fällt
    sub = ndom[row.min():row.max() + 1, col.min():col.max() + 1]   # gleiche Ausrichtung wie das Raster
    sm = ndimage.gaussian_filter(sub, 0.8)
    peaks = (sm == ndimage.maximum_filter(sm, size=5)) & (sm >= 3.5)
    trees = []
    dirs = [(np.cos(t), np.sin(t)) for t in np.linspace(0, 2 * np.pi, 8, endpoint=False)]
    for r_, c_ in zip(*np.nonzero(peaks)):
        x, z = float(xs[c_]), float(xs[r_])
        if x * x + z * z > (R - 2) ** 2 or any(p.contains(Point(x, z)) for p in houses):
            continue
        top = sub[r_, c_]
        rad = []
        for dx, dz in dirs:
            d = 1
            while d < 8:
                rr, cc = int(round(r_ + dz * d)), int(round(c_ + dx * d))
                if not (0 <= rr < sub.shape[0] and 0 <= cc < sub.shape[1]) or sub[rr, cc] < top * 0.6:
                    break
                d += 1
            rad.append(d - 0.5)
        crown = float(np.clip(np.mean(rad), 0.8, 7))
        g = float(H[r_, c_])
        depth = float(np.clip(top * 0.45, 1.2, 9))      # Kiefern: Krone nur oben am Stamm
        trees.append([x, z, round(g - bd.BASE, 2), round(float(top), 1), round(crown, 1), round(depth, 1)])

    # Büsche: niedriger Bewuchs 1-3,5 m, im 2-m-Raster, nicht direkt an einer Krone
    bushes = []
    tree_xy = np.array([[t[0], t[1]] for t in trees]) if trees else np.zeros((0, 2))
    for r_ in range(0, sub.shape[0], 2):
        for c_ in range(0, sub.shape[1], 2):
            v = sub[r_, c_]
            x, z = float(xs[c_]), float(xs[r_])
            if not (1.2 <= v < 3.5) or x * x + z * z > (R - 2) ** 2:
                continue
            if len(tree_xy) and np.min(np.hypot(*(tree_xy - [x, z]).T)) < 2.5:
                continue
            if any(p.contains(Point(x, z)) for p in houses) or H[r_, c_] < bd.WATER:
                continue
            bushes.append([x, z, round(float(H[r_, c_]) - bd.BASE, 2), round(float(v), 1)])

    # ---- Flurstücke und Dinge von den Fotos aus dem bisherigen Diorama übernehmen
    parcels = {}
    for nr, key in (("16", "am-see-16"), ("89", "am-see-89")):
        m = json.load(open(os.path.join(a.out, key + ".json")))
        ox, oz = m["origin"][0] - CE, CN - m["origin"][1]
        parcels[nr] = [[round(x + ox, 2), round(z + oz, 2)] for x, z in m["parcel"]]
        if nr == "16":
            objs = shift(m["objects"], ox, oz)
    model = {
        "crs": "EPSG:25833", "origin": [CE, CN], "base": bd.BASE, "water": round(bd.WATER - bd.BASE, 2), "radius": R,
        "heights": [int(round((v - bd.BASE) * 100)) for v in H.ravel()], "cover": "".join(cover.ravel()),
        "buildings": bld, "trees": trees, "bushes": bushes, "parcels": parcels, "objects": objs,
        "attribution": "© GeoBasis-DE/M-V 2026 (ALKIS, DGM1, nDOM, LoD2), © OpenStreetMap-Mitwirkende",
    }
    with open(os.path.join(a.out, "umgebung.json"), "w") as f:
        json.dump(model, f, separators=(",", ":"), ensure_ascii=False)
    print("%d Gebäude, %d Bäume, %d Büsche, %d Wegpunkte" % (len(bld), len(trees), len(bushes), int((cover == "r").sum())))


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
