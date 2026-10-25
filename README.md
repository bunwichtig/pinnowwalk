# Pinnow Walk

Begehbares 3D-Modell der Landschaft rund um **Am See 89, 19065 Pinnow (OT Godern)** im Browser.
Begehbar sind 100 m rund um das Grundstück: Gelände, Luftbild, 3D-Gebäude mit gezeichneten Fassaden (Putz, Klinker, Holz, Fenster, Dachziegel in der Dachfarbe aus dem Luftbild) und sinnbildliche Bäume.

**Aufruf:** https://bunwichtig.github.io/pinnowwalk/ (sobald GitHub Pages eingeschaltet ist)

## Steuerung
- **Computer:** ins Bild klicken, Maus = umsehen, `W A S D` = gehen, `Shift` = rennen, `Leertaste` = springen,
  `F` = fliegen (dann `Leertaste`/`C` hoch/runter), `H` = zurück zum Grundstück, `Esc` = Maus freigeben.
  Klick auf die Übersichtskarte springt an diese Stelle.
- **Handy/Tablet:** linke Bildschirmseite ziehen = gehen, rechte Seite ziehen = umsehen.

## Eigene Fotos
Eigene Fotos und Videos dienen nur als Vorlage, um das Modell realistischer zu machen (Fassaden, fehlende Objekte,
Baumarten, ggf. Fotogrammetrie). Sie werden **nicht** auf der Seite gezeigt und **nicht** in dieses öffentliche
Repository hochgeladen. Hier landen nur daraus abgeleitete Texturen und Modelle, ohne Personen.

## Technik
- HTML, CSS, JavaScript; 3D mit [three.js](https://threejs.org) (MIT).
  Keine Installation, kein Server nötig: GitHub Pages liefert die Dateien direkt aus.
- `tools/build_data.py` (Python) lädt die Geodaten und erzeugt die Dateien in `data/`:

| Datei | Inhalt |
|---|---|
| `terrain.bin` | Geländehöhen aus DGM1, 1-m-Raster, 261 × 261 Werte (Uint16, cm über 27 m NHN) |
| `dop.jpg` | Luftbild (DOP, ca. 13 cm/Pixel) als Bodentextur; daraus auch die Dachfarben |
| `buildings.bin` | LoD2-Gebäude als Dreiecke mit Texturkoordinaten und Farbe, nach Fassadenart gruppiert |
| `footprints.json` | Gebäudegrundrisse, damit man nicht durch Wände läuft |
| `trees.bin` | Sinnbildliche Bäume: hohe Bäume aus dem nDOM, mindestens 9 m Abstand |

Neu erzeugen: `pip install -r tools/requirements.txt && python3 tools/build_data.py`

## Datenquellen und Lizenz
Geobasisdaten des Landesamts für innere Verwaltung M-V (LAiV), frei nutzbar mit Quellenvermerk:
**© GeoBasis-DE/M-V 2026** – DGM1, nDOM, LoD2-Gebäude, Digitale Orthophotos. Bezug über
[GeoPortal.MV](https://www.geoportal-mv.de) bzw. die Downloaddienste auf www.geodaten-mv.de.
Adresse gefunden über © OpenStreetMap-Mitwirkende (Nominatim).
