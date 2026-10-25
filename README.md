# Pinnow Walk – Am See 16 und Flurstück 89

Begehbares Modell des Grundstücks **Am See 16, 19065 Pinnow (OT Godern)**, Flurstücke 111/90 und 111/91,
als schlichtes Diorama ohne Texturen. Alle Formen kommen aus amtlichen Messdaten oder aus den eigenen Fotos;
nichts ist dazuerfunden.

**Aufruf:** https://bunwichtig.github.io/pinnowwalk/

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
