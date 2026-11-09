# Pinnow Walk – Weltkarte, Am See 16, Flurstück 89 und Dorfstraße 2

**Aufruf:** https://bunwichtig.github.io/pinnowwalk/ – die Startseite bietet die Auswahl:

- **Weltkarte** (`welt.html`): 14 × 14 km rund um den Pinnower See als grobe Pixelgrafik. Gelände (DGM1, 10-m-Raster),
  alle LoD2-Gebäude, höchstens ein Baum je 25 × 25 m (aus dem nDOM), Bodenfarben als 4-m-Pixel (aus nDOM, DGM und den
  Farben des Luftbilds abgeleitet; das Luftbild selbst wird nicht gezeigt). Die Karte liegt in 1-km-Kacheln unter
  `data/welt/`; geladen wird nur der Umkreis von 3 km, Bäume bis 1,5 km. Erzeugt mit `python3 tools/build_world.py`.
- **Am See 16 mit Umgebung** (`umgebung.html`, `js/area.js`): das Haus mit 100 m Umkreis bis zum See, alle
  LoD2-Häuser, Bewuchs aus dem nDOM als Blöcke an der gemessenen Kronenoberfläche (wie bei der Dorfstraße 2), Weg
  „Am See“ (OSM), Ufer mit Schilf, Steg und die Dinge von den Fotos. Dachfarben und Baumfarben aus dem Luftbild
  abgeleitet, Bodenarten (Wiese, trockene Wiese, offener Boden, Sandweg) ebenfalls; das Luftbild selbst wird nicht
  gezeigt. Nach den Fotos: eigenes Haus dunkelbraunes Holz mit dunklen Schindeln, Wohnhäuser cremegelbe
  Holzverschalung, Schuppen dunkelbraune Bretter, Kiefern mit oranger Rinde oben, Lattenzaun zum Sandweg,
  Bretterzaun zum Nachbarn, Baustelle auf der 89. Startpunkte 16 oder 89 (`?ort=89`). Erzeugt mit `python3 tools/build_area.py` → `data/umgebung.json`.
- **Dioramen** (`diorama.html?ort=16`, `?ort=89` bzw. `?ort=dorf2`), siehe unten.

### Dorfstraße 2 (`?ort=dorf2`)
Haus Dorfstraße 2 in Pinnow-Dorf (Flurstück 56/4, rot umrandet) mit allem im Umkreis von 100 m: Gelände (DGM1),
alle LoD2-Häuser, Bewuchs aus dem nDOM (im Flurstück 1-m-, außerhalb 2-m-Blöcke), Straßen und Wege aus
OpenStreetMap (© OpenStreetMap-Mitwirkende, ODbL). Dachfarben vereinfacht aus dem Luftbild (das Luftbild selbst wird
nicht gezeigt). Nach den eigenen Fotos: Backstein und Putz am Haus, Holzanbau, Holzbalkon im Putzgiebel,
Lattenzaun, Doppelkopf-Laternen, grünes Wartehäuschen, Haltestellenschilder, Terrasse und Wäscheleine im Garten.

## Dioramen

Begehbares Modell des Grundstücks **Am See 16, 19065 Pinnow (OT Godern)**, Flurstücke 111/90 und 111/91,
als schlichtes Diorama ohne Texturen. Alle Formen kommen aus amtlichen Messdaten oder aus den eigenen Fotos;
nichts ist dazuerfunden.

## Was woher kommt
| Teil | Quelle |
|---|---|
| Grundstücksgrenze | ALKIS-Flurstücke 111/90 und 111/91, dazu der Uferstreifen bis zum Steg |
| Gelände | DGM1 (1-m-Höhenmodell) |
| Haus | LoD2-Gebäudemodell (echte Dachform) |
| Bewuchs | nDOM (gemessene Höhe über Gelände) als 1-m-Blöcke an der Kronenoberfläche; Stämme an den Kronenspitzen |
| Steg mit Badeleiter, Betonstufen am Hang, Terrasse mit Betonplatten, Wellblech-Vordach, umgedrehtes Boot, Beet mit Steinen | nach den eigenen Fotos; Lage geschätzt (Steg aus dem Luftbild) |

Die eigenen Fotos liegen nicht in diesem Repository und werden nicht gezeigt.

## Steuerung
- **Computer:** ins Bild klicken, Maus = umsehen, `W A S D` = gehen, `Shift` = schneller, `Leertaste` = springen,
  `F` = fliegen (`Leertaste`/`C` hoch/runter), `U` = Übersicht, `H` = Terrasse, `Esc` = Maus freigeben.
- **Handy/Tablet:** linke Seite ziehen = gehen, rechte Seite ziehen = umsehen.
- Klick in die kleine Karte: dorthin gehen.

## Technik
HTML, CSS, JavaScript mit [three.js](https://threejs.org) (MIT). Alle Daten stecken in `data/am-see-16.json` und `data/am-see-89.json` (Flurstück 111/89, schräg gegenüber; Auswahl auf der Startseite oder per `?ort=89`),
erzeugt mit `tools/build_data.py` (Python):

```
pip install -r tools/requirements.txt
python3 tools/build_data.py
```

## Datenquellen
Geobasisdaten des LAiV M-V: **© GeoBasis-DE/M-V 2026** (ALKIS, DGM1, nDOM, LoD2), frei nutzbar mit Quellenvermerk,
Bezug über [GeoPortal.MV](https://www.geoportal-mv.de) bzw. www.geodaten-mv.de.
