# Pinnow Walk

Begehbares 3D-Modell der Landschaft rund um **Am See 89, 19065 Pinnow (OT Godern)** im Browser.
Ausschnitt 1,2 km × 1,2 km um das Grundstück, mit Gelände, Luftbild, allen 3D-Gebäuden und Bäumen.

**Aufruf:** https://bunwichtig.github.io/pinnowwalk/ (sobald GitHub Pages eingeschaltet ist)

## Steuerung
- **Computer:** ins Bild klicken, Maus = umsehen, `W A S D` = gehen, `Shift` = rennen, `Leertaste` = springen,
  `F` = fliegen (dann `Leertaste`/`C` hoch/runter), `H` = zurück zum Grundstück, `Esc` = Maus freigeben.
  Klick auf die Übersichtskarte springt an diese Stelle.
- **Handy/Tablet:** linke Bildschirmseite ziehen = gehen, rechte Seite ziehen = umsehen, Marker antippen = Foto.

## Fotos einbinden
1. Foto (Original vom Handy, nicht über Messenger weitergeleitet) in den Ordner `fotos/` hochladen.
2. Einen Eintrag in `fotos/fotos.json` ergänzen:

```json
[
  {
    "datei": "IMG_1234.jpg",
    "titel": "Blick vom Steg",
    "lat": 53.601040,
    "lon": 11.537295,
    "richtung": 290,
    "neigung": 0,
    "brennweite": 26
  }
]
```

| Feld | Bedeutung |
|---|---|
| `lat`, `lon` | Aufnahmeort (Breite/Länge, WGS84). Alternativ `ost`/`nord` in UTM 33 (EPSG:25833). |
| `richtung` | Blickrichtung in Grad: 0 = Nord, 90 = Ost, 180 = Süd, 270 = West |
| `neigung` | optional, Grad nach oben (+) oder unten (−) |
| `brennweite` | optional, Kleinbild-Brennweite in mm (Handy meist 24–28), passt den Bildwinkel an |
| `hoehe_ueber_boden` | optional, Kamerahöhe in m (Standard 1,6) |

Einfacher geht es auf der Seite selbst: **📷 Fotos → Eigenes Foto testen**. Die Seite liest GPS und Blickrichtung
aus dem Foto, zeigt es halbtransparent über dem Modell und erzeugt den fertigen Eintrag zum Kopieren.
Fehlen die Daten, im Modell an den Aufnahmeort gehen, so drehen, dass Foto und Modell übereinander passen,
und **Aktueller Standort** drücken.

Hinweis: Das Repository und die Seite sind öffentlich. Fotos mit erkennbaren Personen oder Kennzeichen vorher unkenntlich machen.

## Technik
- HTML, CSS, JavaScript; 3D mit [three.js](https://threejs.org) (MIT), Koordinaten mit [proj4js](https://proj4js.org) (MIT).
  Keine Installation, kein Server nötig: GitHub Pages liefert die Dateien direkt aus.
- `tools/build_data.py` (Python) lädt die Geodaten und erzeugt die Dateien in `data/`:

| Datei | Inhalt |
|---|---|
| `terrain.bin` | Geländehöhen aus DGM1, 2-m-Raster, 601 × 601 Werte (Uint16, cm über 27 m NHN) |
| `dop_4k.jpg`, `dop_2k.jpg` | Luftbild (DOP) als Bodentextur, auch für die Dachfarben |
| `buildings.bin` | LoD2-Gebäude (Dächer und Wände) als Dreiecke |
| `footprints.json` | Gebäudegrundrisse, damit man nicht durch Wände läuft |
| `trees.bin` | Baumstandorte und -höhen aus dem normalisierten Oberflächenmodell (nDOM) |

Neu erzeugen: `pip install -r tools/requirements.txt && python3 tools/build_data.py`

## Datenquellen und Lizenz
Geobasisdaten des Landesamts für innere Verwaltung M-V (LAiV), frei nutzbar mit Quellenvermerk:
**© GeoBasis-DE/M-V 2026** – DGM1, nDOM, LoD2-Gebäude, Digitale Orthophotos. Bezug über
[GeoPortal.MV](https://www.geoportal-mv.de) bzw. die Downloaddienste auf www.geodaten-mv.de.
Adresse gefunden über © OpenStreetMap-Mitwirkende (Nominatim).
