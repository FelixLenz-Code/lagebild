# Lagebild

Eine **offline-first PWA**, die Informationen fürs sichere Bewegen in der Welt bündelt:
Wetter & Regenradar, amtliche Warnungen (NINA/BBK), Verkehr (Autobahn), Bahn/ÖPNV,
Pegelstände, Luftqualität und relevante News — standortbezogen und auf Wunsch
pro Bundesland offline verfügbar. Fokus: Deutschland.

## Architektur

Monorepo (pnpm workspaces):

| Paket | Zweck |
| --- | --- |
| `apps/web` | React-PWA (Vite). Zoombare Lagekarte, Kacheln, Offline-Cache. |
| `apps/api` | Hono-Proxy. Normalisiert externe Quellen, umgeht CORS/Rate-Limits, cached. |
| `packages/shared` | Gemeinsame TypeScript-Datentypen. |

Der Server ist **zustandslos** (nur Proxy + kurzer Cache; einzige Ausnahme ist
der kurzlebige AIS-Positionsspeicher) — die Offline-Daten liegen im Browser.
Datenquellen sind überwiegend freie, offizielle APIs (Bright Sky/DWD,
warnung.bund.de/NINA, Autobahn, PEGELONLINE, Open-Meteo, Tagesschau, DB,
adsb.fi, adsbdb.com, aisstream.io, aprs.fi).

## Entwicklung

```bash
pnpm install
pnpm dev        # startet API (Port 8787) + Web (Port 5173) parallel
```

Frontend: http://localhost:5173 · API-Health: http://localhost:8787/api/health

```bash
pnpm build      # baut alle Pakete
pnpm typecheck  # Typprüfung über alle Pakete
```

## Kartenebenen

Die Karte startet **ohne** Fachebenen. Alle Ebenen liegen im Ausklapp-Menü
**„Ebenen"** oben links (nach Themen gruppiert, mit Zähler der aktiven Ebenen
und „Alle aus"); das Zeichenwerkzeug bleibt als eigener Knopf daneben:

| Ebene | Quelle | Hinweis |
| --- | --- | --- |
| Warnungen | DWD-GeoServer (NINA-Skala) | mit Warnstufen-Filter |
| Regenradar | DWD RADOLAN-RV / RainViewer | Zeitleiste bis +2 h |
| Wind | Open-Meteo | animiertes Strömungsbild (10 m über Grund) |
| Verkehrsfluss | TomTom | nur mit gültigem `TOMTOM_KEY` |
| Verkehr / Pegel | Autobahn GmbH / PEGELONLINE | folgen dem Kartenausschnitt |
| Flugzeuge | adsb.fi (offenes ADS-B-Netz) | ab Zoom 6, aktualisiert alle 15 s |
| Schiffe | aisstream.io (AIS) | nur mit `AISSTREAM_KEY` |
| Amateurfunk | aprs.fi (APRS) | nur mit `APRSFI_KEY`, feste Rufzeichenliste |
| Busse & Bahnen | transitous.org (MOTIS) | Fahrzeuge in Bewegung, ab Zoom 10 |
| Notfallpunkte | Offline-Suchindex (OSM) | Klinik, Apotheke, Polizei, Feuerwehr — ohne Netz |
| Erdbeben | USGS | letzte Woche, ab Stärke 2,5 |
| Waldbrandgefahr | DWD | Stufe 1–5, Deutschland |
| Polarlicht | NOAA SWPC (OVATION) | Wahrscheinlichkeit weltweit |
| Tag/Nacht | selbst gerechnet | Dämmerungssaum, wandert minütlich mit |
| Markieren | eigene Punkte/Flächen | Benennung direkt beim Anlegen |

Nicht gebrauchte Ebenen lassen sich unter **Einstellungen → Ebenen** ganz aus
dem Menü nehmen (siehe unten).

Flug- und Schiffspositionen werden nur geladen, solange ihre Ebene an ist, und
bewusst **nicht** offline gespeichert — sie veralten in Sekunden.

Der Knopf mit den Kreispfeilen in der Kopfzeile holt **alle** Datensätze neu;
ohne Verbindung ist er gesperrt, und solange Abfragen laufen, dreht er sich.

Flugzeuge tragen die Silhouette ihrer Musterklasse (Kleinflugzeug, Jet,
Großraum, Hubschrauber, Segelflug — aus der ADS-B-Kategorie abgeleitet), gefärbt
nach Zustand (in der Luft, am Boden, Notfall-Squawk). Das Popup zeigt Höhe samt
eingestellter Zielhöhe, Steig-/Sinkrate, Geschwindigkeiten (über Grund, IAS,
Mach), Kurs, Wind und Temperatur in Flughöhe, Squawk und Abstand. Halter und
**Flugroute** (Start- und Zielflughafen) holt `/api/aircraft/<icao>` beim
Antippen von [adsbdb.com](https://api.adsbdb.com) nach — frei und ohne Key.

## Einstellungen und Quellen

Das Zahnrad in der Kopfzeile öffnet ein Blatt mit drei Reitern — hier wächst
künftig alles hinein, was Einstellung ist:

- **Ebenen**: jede Kartenebene lässt sich aus dem Menü „Ebenen" nehmen. Wer
  Amateurfunk oder Erdbeben nie braucht, blendet sie aus; die Ebene wird dabei
  ausgeschaltet. Jede Zeile nennt gleich mit, woher ihre Daten kommen. Die
  Auswahl liegt im localStorage und überlebt den Neustart.
- **App**: selbsttätiges Aktualisieren (aus, 5, 15, 30 Minuten — ohne Verbindung
  passiert nichts), Ortung beim Start, Ansagen bei der Zielführung (derselbe
  Schalter wie in der Navigationsleiste, nur dauerhaft), Verweis auf die
  Offline-Regionen und ein kurzes Wort dazu, dass alle Daten auf dem Gerät
  bleiben.
- **Quellen**: alle Datenanbieter mit Rücklink und der jeweiligen Bedingung
  bzw. Bitte (Lizenz, Schlüsselpflicht, Cache-Zusage), dazu die verwendeten
  freien Projekte (MapLibre, PMTiles, React, Vite, Hono, Dexie, MOTIS …).

Die Ebenenliste hat nur **eine** Quelle: `layerCatalog.ts`. Sowohl das Menü auf
der Karte als auch die Einstellungen bauen daraus ihre Zeilen — sonst driften
Namen und Gruppen auseinander. `sources.ts` hält die Anbieterliste, `settings.ts`
den kleinen Speicher.

## Wetter & Regenradar

* **Vorhersage**: `/api/weather/forecast` liefert aus Bright Sky (DWD) den
  Stundenverlauf (48 h) und eine daraus aggregierte 7-Tage-Übersicht. Die
  Detailansicht fasst die **nächsten 24 Stunden** in einem Diagramm mit
  gemeinsamer Zeitachse zusammen: Wettersymbol, Temperaturkurve und darunter
  der Regen — Balken nach Stärke gefärbt (leicht/mäßig/stark, Schwellen wie in
  der Radar-Legende) und darunter die Regenwahrscheinlichkeit als Wert je
  Stunde (hervorgehoben ab 30 bzw. 60 %). Nachtstunden sind
  hinterlegt, eine Marke zeigt „jetzt", und beim Antippen einer Stunde stehen
  Temperatur, Menge, Wahrscheinlichkeit und Wind im Klartext darüber. Die
  Kopfzeile nennt die Regenphasen („Regen 13–19 Uhr, 0–3 Uhr · 13,6 mm
  gesamt · Spitze 4,6 mm/h"). Darunter folgen 7 Tage und die Luftqualität.
* **Wind**: `/api/wind` legt ein Gitter über den Ausschnitt und holt die
  Punkte in **einer** Open-Meteo-Anfrage (frei, ohne Key). Auf der Karte wird
  daraus ein **Strömungsbild**: Hunderte Teilchen treiben über ein eigenes
  Canvas mit dem Wind und ziehen verblassende Spuren; zwischen den
  Gitterpunkten wird bilinear interpoliert, die Farbe zeigt die Stärke
  (Beaufort-nah). Die Zahlenwerte in km/h an den Gitterpunkten lassen sich im
  Menü als Unterpunkt „Windwerte" zuschalten (standardmäßig aus). Bei
  `prefers-reduced-motion` bleibt das Bild stehen. Freie
  Wind-Kacheldienste gibt es nicht, das Gitter ist der praktikable Weg.
* **Regenradar**: In Deutschland zeigt die Karte das **DWD-Vorhersageradar**
  (RADOLAN-RV via Bright Sky, `/api/radar/forecast`): 5-Minuten-Schritte von
  ~30 min Vergangenheit bis **+2 h**. Das Backend reicht die zlib-komprimierten
  Gitter durch, der Browser packt sie aus (`DecompressionStream`) und malt daraus
  das Kartenbild. Außerhalb Deutschlands (oder ohne `DecompressionStream`) fällt
  die App automatisch auf die RainViewer-Kacheln zurück.

## Schiffsverkehr (AIS) einrichten

AIS gibt es nicht schlüssellos: Der Key von [aisstream.io](https://aisstream.io)
ist kostenlos, erfordert aber eine Registrierung. Anschließend in
`apps/api/.env` eintragen:

```bash
AISSTREAM_KEY=dein-key
# optional: beobachteter Ausschnitt als sued,west,nord,ost (Standard: Deutschland)
# AISSTREAM_BBOX=47.0,5.5,56.0,15.5
```

aisstream liefert per WebSocket — der Server hält die zuletzt gemeldeten
Schiffe deshalb bis zu 20 Minuten im Speicher (gedeckelt, kein Datenbank-State)
und beantwortet daraus die Ausschnitts-Abfragen. Ohne Key bleibt die Ebene
unsichtbar; `/api/health` meldet das als `features.ais`.

## Amateurfunk (APRS) einrichten

Key im [aprs.fi](https://aprs.fi/)-Konto unter *My account* holen (kostenlos)
und eintragen — laut Nutzungsbedingungen **je Nutzer ein eigener Key**:

```bash
APRSFI_KEY=dein-key
```

Wichtig fürs Verständnis der Ebene: Die aprs.fi-API beantwortet ausdrücklich
**nur Abfragen konkreter Rufzeichen** — es gibt keine Umkreis- oder
Wildcard-Suche. Über das Stift-Symbol neben „Amateurfunk" pflegst du deshalb
eine Beobachtungsliste (max. 20 Rufzeichen, so viele erlaubt die API pro
Abfrage). Wetterstationen liefern zusätzlich Temperatur, Wind, Druck und Regen.

Die Route hält sich an die [API-Bedingungen](https://aprs.fi/page/api):
sprechender User-Agent, Abruf nur bei eingeschalteter Ebene (im Minutentakt,
serverseitig 45 s gecacht), exponentielles Zurückfahren nach Fehlern, und die
Quellenangabe mit Rücklink auf aprs.fi steht im Menü, in der Rufzeichenliste
und in jedem Popup. Ein abgelehnter Key schaltet die Ebene automatisch ab.

## Standort und Suche sind getrennt

* **Standort** (Knopf mit Ortsnamen): kommt ausschließlich aus der Ortung oder
  von Hand über die Karte („Auf der Karte setzen" bzw. Rechtsklick/langes
  Antippen → „Hierher wechseln"). Er steuert Wetter, Warnungen und alle Kacheln.
* **Suche** (Lupe): findet ausschließlich **Ziele** und fährt sie an. Sie setzt
  nie den Standort.

## Suche (Adressen, Orte, POIs)

Die Suche findet Adressen mit Hausnummer, Straßen, Ortsnamen und Punkte wie
„Tankstelle", „Apotheke" oder „Bahnhof". Ganz oben stehen die **eigenen
Markierungen** aus dem Zeichenwerkzeug (Punkte und Flächen, Flächen über ihren
Mittelpunkt) — auch sie lassen sich direkt anfahren, ebenso über „Route hierher"
im Kartenmenü. Mit dem Stern wird ein Treffer als **gespeichertes Ziel**
abgelegt. Darunter kommen die beiden Quellen, zusammengeführt:

* **offline** aus dem gespeicherten Suchindex der Region (siehe unten) — mit
  Entfernung zum Standort, auch ganz ohne Netz;
* **online** über [Photon](https://photon.komoot.io/) (Komoot, ohne Key), auf
  Deutschland eingegrenzt und um den aktuellen Standort herum bevorzugt.

Auf der Karte öffnet ein langes Antippen bzw. die rechte Maustaste dasselbe Menü
für einen beliebigen Punkt („Route hierher", „Als Start setzen", „Hierher
wechseln").

## Routenplanung und Navigation (komplett offline)

Gerechnet wird ausschließlich auf dem Gerät — es gibt keinen Routing-Dienst im
Hintergrund. Grundlage ist der Routing-Graph der heruntergeladenen Region:

* Profile **Auto, Fahrrad, zu Fuß** mit eigenen Zugangsregeln (Einbahnstraßen,
  gesperrte Wege, Kraftfahrstraßen), Tempolimits und Geschwindigkeiten je
  Straßenklasse;
* **bis zu drei Varianten** zur Auswahl: die schnellste plus zwei tatsächlich
  anders verlaufende Wege. Sie entstehen, indem die schon benutzten Kanten mit
  einem Aufschlag belegt und die Suche wiederholt wird; übernommen wird ein Weg
  nur, wenn er sich um mehr als ein Drittel unterscheidet und nicht wesentlich
  länger dauert. Die nicht gewählten liegen grau auf der Karte und lassen sich
  antippen. Dazu ein Schalter **„Autobahn meiden"**, der alle drei neu rechnet;
* A*-Suche in einem Worker (typische Stadtroute unter 50 ms), Start und Ziel
  werden auf die nächstgelegene befahrbare Kante gefangen;
* **Abbiegeverbote** aus OSM (`type=restriction`): die Suche läuft über
  gerichtete Kanten, kennt also die Straße, aus der man kommt — damit sind
  `no_left_turn` & Co. sowie das Wendeverbot exakt statt geschätzt;
* deutsche Fahranweisungen inklusive Kreisverkehr-Ausfahrten, Auf- und
  Ausfahrten; Ansagen nur dort, wo es an der Kreuzung wirklich eine Wahl gibt;
* **Zielführung** mit Positionsverfolgung, mitdrehender Karte, Restweg/Ankunft,
  Sprachansagen (SpeechSynthesis des Geräts, abschaltbar) und automatischer
  Neuberechnung, wenn man von der Route abkommt.

### ÖPNV-Verbindungen

Neben Auto, Rad und Fuß gibt es den Reiter **ÖPNV**. Er fragt bei
transitous.org (`/api/transit/plan` → MOTIS `/plan`) drei Verbindungen ab und
zeigt Abfahrt, Ankunft, Dauer und Umstiege sowie den vollständigen Ablauf:
Fußwege, Linien mit Verkehrsmittel im Klartext, Zielbeschilderung und Anzahl der
Zwischenhalte. Die gewählte Verbindung liegt auf der Karte — Fahrten in der
Farbe des Verkehrsmittels, Fußwege gestrichelt.

Zeitpunkt wählbar als **„Abfahrt um …" oder „Ankunft bis …"** (Datum und
Uhrzeit), sonst ab jetzt. Jeder längere **Fußweg lässt sich an die
Offline-Navigation übergeben** („Fußweg navigieren") — der Weg zur Haltestelle
wird dann auf dem gespeicherten Graphen gerechnet und ganz normal angesagt.

Anders als die anderen Profile braucht der ÖPNV **eine Verbindung ins Netz**:
Fahrpläne und Echtzeit liegen nicht im Gerät. Ohne Netz sagt der Reiter das.

### Über Landesgrenzen hinweg

Die Graphen liegen zwar je Bundesland als Datei vor, das Routing kennt diese
Grenze aber nicht: Für eine Anfrage werden **alle gespeicherten Regionen entlang
der Luftlinie** geladen und zu einem Netz verbunden. Ob eine Gegend abgedeckt
ist, entscheidet dabei der Graph selbst (lässt sich der Punkt aufs Straßennetz
fangen?) — die groben Bundesland-Rechtecke überlappen sich zu stark, um das zu
beantworten: das rheinland-pfälzische reicht bis Wiesbaden hinein. Die Geofabrik-Auszüge
überlappen an den Landesgrenzen — dieselben Knoten liegen dort in beiden Dateien
mit identischen Koordinaten und werden über Verbindungskanten der Länge 0
zusammengeführt. Fehlt eine Region auf dem Weg, sagt die App das und die Route
erscheint automatisch, sobald sie geladen ist.

Speicher wächst dabei nur mit dem, was wirklich gebraucht wird: eine Fahrt durch
zwei Länder lädt zwei Graphen, nicht ganz Deutschland. Eine einzige
Deutschland-Datei wäre ~1,2 GB groß und ließe sich im Browser nicht am Stück
laden.

Nicht unterstützt: Abbiegeverbote mit `via`-**Weg** (statt via-Knoten) — meist
Wendeverbote an getrennten Fahrbahnen; sie werden beim Bauen gezählt und
übersprungen.

## Offline-Pakete pro Bundesland

Je Bundesland gibt es drei Dateien, die der Browser in den OPFS lädt
(„Offline"-Knopf in der Topbar):

| Datei | Inhalt | Größe (Beispiel Bremen) |
| --- | --- | --- |
| `<code>.pmtiles` | Hintergrundkarte (Vektorkacheln) | 22 MB |
| `<code>.route` | Routing-Graph (Knoten, Kanten, Geometrie, Namen, Abbiegeverbote) | 1,9 MB |
| `<code>.search` | Suchindex (Orte, Straßen, POIs, Hausnummern) | 1,6 MB |

`.route` und `.search` liegen deflate-gepackt auf dem Server und werden beim
Herunterladen einmalig entpackt abgelegt: kleiner Download, schneller Start, und
die Hausnummernblöcke lassen sich später gezielt aus der Datei lesen, statt sie
im Speicher zu halten.

Über „Deutschland komplett" im Offline-Bildschirm lassen sich alle auf dem
Server vorhandenen Regionen in einem Rutsch laden.

### Routing- und Suchdaten erzeugen

```bash
scripts/build-routing.mjs           # alle 16 Länder (lädt die OSM-Auszüge)
scripts/build-routing.mjs 04 11     # nur einzelne (Code)
```

Das Skript lädt den Geofabrik-Auszug des Landes (`.osm.pbf`, Ablage in
`.cache/osm`) und baut daraus beide Pakete: es liest die Datei zweimal (erst
Wege und Abbiege-Relationen, dann Knoten), erkennt Kreuzungen, zieht die Straßen
zu Kanten zusammen, vereinfacht die Geometrie auf 4 m und verwirft abgehängte
Insel-Teilgraphen.
Parallel entstehen Sucheinträge: Straßen und POIs bekommen den nächstgelegenen
Ort zugeordnet, Adressen werden nach Straße gebündelt.

Env: `PBF_DIR`, `OUT_DIR` (Default `apps/api/maps`), `PBF` (fertiger Auszug),
`KEEP_PBF=0` (Auszug nach dem Bauen löschen). Große Länder brauchen ein paar
Minuten und mehrere GB Heap — das Skript startet sich dafür selbst neu.
Anhaltspunkte: Bremen (21 MB Auszug) baut in 10 s zu 1,9 + 1,6 MB, Hessen
(343 MB) in 2:46 zu 34 + 18 MB bei 1,1 GB Spitzenspeicher, Niedersachsen
(1 GB) in 4:20 zu 49 + 28 MB.

Prüfen lässt sich das Ergebnis ohne Browser:

```bash
apps/api/node_modules/.bin/tsx scripts/check-offline.mts apps/api/maps 04
```

Das lädt Graph und Index mit denselben Modulen wie die App und rechnet ein paar
Beispielrouten und -suchen durch. Mehrere Codes durch Komma getrennt (z.B.
`04,03`) prüfen das Zusammensetzen mehrerer Regionen.

### Hintergrundkarte erzeugen

Die PMTiles-Dateien erzeugst du einmalig:

```bash
scripts/build-maps.sh            # alle 16 Länder nach apps/api/maps/
scripts/build-maps.sh 04 11      # nur einzelne (Code)
```

Das Skript schneidet die Ausschnitte per `pmtiles extract` aus einer Planet-PMTiles
(Default: öffentliche Protomaps-Planet-Datei, Protomaps-Schema — passend zum Style;
`SOURCE`/`OUT_DIR`/`MAXZOOM` sind per Env übersteuerbar). Der API-Server liefert alle
drei Paketarten automatisch unter `/api/maps` aus. Dateien in `apps/api/maps/` sind
gitignored (große Binärdaten).

Die **Online**-Basiskarte kommt aus `VITE_MAP_PMTILES_URL` (Default: Protomaps-Demo;
in Produktion auf die eigene, gehostete Deutschland-PMTiles zeigen).

## Bahn / ÖPNV

Halte in der Nähe und ihre Abfahrten kommen von **transitous.org** (MOTIS-API,
frei und ohne Schlüssel). Das Projekt bündelt die offiziellen Fahrplandaten der
Verbünde (in Deutschland DELFI) samt Echtzeit — also Bahn, S-Bahn, Tram, U-Bahn
und Bus. Zwei Aufrufe je Abfrage (`/reverse-geocode` für die Halte,
`/stoptimes` je Halt), serverseitig 60 s gecacht; Basis-URL über `TRANSIT_BASE`
umstellbar.

Die frühere Quelle `v6.db.transport.rest` (HAFAS) antwortet dauerhaft mit 503
und wurde ersetzt.

### Haltestellen auf der Karte

Die Ebene **„Haltestellen"** (Gruppe Verkehr) zeigt ab Zoom 12 alle Bus-, Tram-,
Bahn- und Fährhaltestellen, ab Zoom 13 mit Namen — als farbiger Kreis mit
Piktogramm (blau Bus, violett Tram/U-Bahn, rot Bahn, türkis Fähre).

Quelle sind die **Fahrplandaten** (`/api/stops` → transitous.org), nicht
OpenStreetMap: dort steht nur, was tatsächlich bedient wird, stillgelegte
Bahnhöfe tauchen also gar nicht erst auf. Die einzelnen Steige einer Haltestelle
werden nach Name und Lage (bis 150 m) zusammengefasst, und weil Fahrplandaten den
Ort voranstellen („Bremen Fürther Straße"), wird ein im Ausschnitt dominierender
Ortsname für die Kartenbeschriftung weggelassen. Ohne Netz springt der
Offline-Suchindex (OSM) ein, damit die Ebene auch dann etwas zeigt.

In der Kachel **Bahn / ÖPNV** und in ihrer Detailliste führt „Hinfahren" jede
Haltestelle direkt in die Routenplanung.

Ein Tipp auf eine Haltestelle öffnet ihre **nächsten Abfahrten** (alle Steige
zusammen, mit Echtzeit) samt „Route hierher" und „Als Start setzen". Eigene
Markierungen öffnen weiterhin das kleine Kartenmenü.

Jede Abfahrt lässt sich antippen und zeigt dann den **restlichen Laufweg der
Fahrt**: alle Halte ab hier mit Ankunftszeiten und Verspätung (`/api/stops/trip`
→ MOTIS `/trip`). Die Verkehrsmittel stehen dabei immer auch im Klartext neben
der Liniennummer (Bus, Tram, S-Bahn, Regionalzug …) — die Farbe der Plakette ist
nur eine Zugabe, keine alleinige Information. Angezeigt werden nur Abfahrten der nächsten 12 Stunden —
hat ein Halt nichts Näheres, bleiben zwei Einträge als Hinweis stehen (mit
Wochentag, damit „morgen 09:40" nicht wie „gleich" aussieht).

### Busse und Bahnen in Bewegung

Die Ebene **„Busse & Bahnen"** (Gruppe Verkehr) zeigt ab Zoom 10 die Fahrzeuge im
Ausschnitt als gedrehten Pfeil in der Farbe des Verkehrsmittels
(`/api/vehicles` → MOTIS `map/trips`, alle 20 s neu, serverseitig 15 s gecacht).

**Das ist keine GPS-Ortung.** MOTIS liefert keine Fahrzeugpositionen, sondern die
Fahrtabschnitte im Ausschnitt mit Abfahrt, Ankunft und Linienzug. Die Position
wird daraus gerechnet: Anteil der verstrichenen Zeit → Punkt auf der Strecke.
Für Fahrten mit Echtzeitmeldung (in Bremen zur Probe 73 von 79) stecken darin die
**gemeldeten Ist-Zeiten** samt Verspätung, sonst nur der Sollfahrplan; das Blatt
schreibt beides hin. Die Live-Karten der Verkehrsverbünde arbeiten genauso — eine
echte Fahrzeugpeilung gibt es in den offenen Daten (GTFS/GTFS-RT über DELFI)
nicht. Der Linienzug hat hier Genauigkeit 5, anders als bei `/plan`.

Ein Tipp auf ein Fahrzeug öffnet dessen **Fahrplan**: Linie, Ziel, Verspätung und
der ganze Laufweg mit allen Halten; der nächste Halt ist hervorgehoben, schon
abgefahrene stehen blass. Jeder Halt lässt sich als Ziel übernehmen. Gleichzeitig
zeichnet die Karte den **Laufweg der Fahrt** — der Teil vor dem Fahrzeug kräftig
in Linienfarbe, der schon gefahrene grau gestrichelt. „Laufweg auf der Karte"
schließt das Blatt, rückt die Fahrt ins Bild und lässt die Linie stehen; das Band
oben links („Laufweg 25 ✕") holt den Fahrplan zurück oder nimmt die Linie wieder
weg.

## Nachrichten: regional und verortet

Angezeigt werden alle Meldungen der aktuellen Ausgabe — bundesweit rund 55,
dazu bis zu 20 je Landesprogramm. Die Zahl steht als Zähler an der Kachel.

Mit Standort holt die App zusätzlich zum bundesweiten Überblick die Meldungen
des **Regionalprogramms** — die Tagesschau-API führt hessenschau, NDR, BR, MDR,
SWR, rbb, SR und Radio Bremen unter `?regions=<id>`. Weil die
Bundesland-Rechtecke sich überlappen (Bremen liegt in Niedersachsen, Wiesbaden
im rheinland-pfälzischen Rechteck), werden bis zu **zwei Programme** geladen,
das kleinere Land zuerst — für Nachrichten ist der Nachbar ohnehin
interessant. Regionales steht in der Liste vorn, und der Filter „Aus der
Region" blendet alles andere aus.

Die Tagesschau-API liefert je Meldung Schlagworte und eine Regionskennung. Das
Backend leitet daraus einen Ort ab und hängt ihn als `place` an die Meldung:

* Schlagworte mischen Themen und Orte („Gewerkschaften" neben „Schwerin"), und
  eine Ortssuche findet zu fast jedem Wort etwas — „Wetter" etwa eine Stadt im
  Ruhrgebiet. Deshalb wird jeder Treffer **gegen das Bundesland der Meldung
  geprüft**; liegt er außerhalb, war es kein Ortsname.
* Nur Orte und Verwaltungseinheiten zählen (Stadt, Gemeinde, Kreis), keine
  Straßen oder Geschäfte. Landesnamen liefern keinen genauen Ort.
* Bleibt nichts übrig, wird der **Mittelpunkt des Bundeslandes** genommen und als
  „ungenau" gekennzeichnet. Meldungen ohne Region (bundesweit, Ausland) bekommen
  gar keinen Ort.
* Regionalmeldungen tragen als Schlagwort nur das Land („HR", „Hessen"). Den
  genauen Ort verrät oft die Schlagzeile — „CSD **in Schlüchtern**", „Landesstraße
  **bei Penkun**" —, deshalb wird auch daraus ein Kandidat gebildet. Auch er muss
  die Bundeslandprüfung bestehen.
* Geokodiert wird über Photon, mit langem Cache (7 Tage) und höchstens 15 neuen
  Abfragen je Aktualisierung — die Ergebnisse ändern sich ohnehin nicht.

Jede Meldung wird zusätzlich in eine von zehn **Kategorien** einsortiert —
Gefahr, Polizei & Justiz, Verkehr, Wetter, Gesundheit, Politik, Wirtschaft,
Sport, Kultur, Sonstiges. Das geschieht über Stichwortlisten auf Schlagzeile und
Schlagworten (der Anriss dient nur als Rückfall, sonst landet „Wiederaufbau
eines Kirchturms" bei den Gefahren, weil im Text der Brand von damals steht).
Bei den Stichworten wird unterschieden, ob sie ein Wort **beginnen** müssen
(„Brand" ja, „Deichbrand-Festival" nein) oder auch in einer Zusammensetzung
stecken dürfen — im Deutschen steht das Stichwort oft hinten
(„Flugzeugabsturz", „Vollsperrung").

Auf der Karte gibt es dafür die Ebene **„Nachrichten"** (Gruppe Lage): jede
verortete Meldung mit dem Symbol ihrer Kategorie — **Gefahrenmeldungen als
rotes Warndreieck**, das beim Gedränge zuerst gezeichnet wird. Im Popup stehen
Kategorie, Schlagzeile, Zeitpunkt und Link; ungenaue Orte sind blasser. Dieselben
Symbole stehen in der Nachrichtenliste. In der Nachrichtenliste lässt sich auf
**„Mit Ort"** umschalten, und ein Klick auf den Ortsnamen schwenkt die Karte
dorthin.

## Notfallpunkte, Erdbeben, Waldbrand und Polarlicht

Vier weitere Ebenen, jede mit eigener Quelle:

**Notfallpunkte** (Gruppe Lage) kommen ab Zoom 11 aus dem **Offline-Suchindex**
der heruntergeladenen Region — Krankenhaus, Apotheke, Arztpraxis, Polizei,
Feuerwehr, Trinkwasser und Schutzhütte, jeweils mit eigenem Piktogramm.
Kliniken werden beim Gedränge zuerst platziert. Ein Tipp öffnet dasselbe
Kartenmenü wie eigene Markierungen, also mit „Route hierher". Das funktioniert
**ohne Netz** und ist genau dann gedacht, wenn es darauf ankommt.

**Erdbeben** (Gruppe Lage) zeigt die Beben der letzten Woche ab Stärke 2,5
([USGS](https://earthquake.usgs.gov/), gemeinfrei, 10 min Cache). Der Kreis wächst
mit der Stärke, die Farbe geht von gelb über orange nach rot; das Popup nennt
Stärke, Ort, Tiefe, Zeitpunkt und verlinkt den USGS-Bericht.

**Waldbrandgefahr** (Gruppe Gefahren) ist der Waldbrandgefahrenindex des DWD
(Stufe 1–5). Der offene DWD-Server liefert ihn nur je Station als gepackte CSV;
der Server dünnt die Stationsliste auf eine je 0,6°-Zelle aus (rund 155), holt
deren Tageswerte und rechnet daraus per Abstandsgewichtung ein 0,2°-Gitter über
Deutschland (6 h Cache). Die Fläche liegt unter den Warnungen, damit diese
lesbar bleiben.

**Polarlicht** (Gruppe Funk) legt die Sichtungswahrscheinlichkeit des
OVATION-Modells von [NOAA SWPC](https://services.swpc.noaa.gov/) (gemeinfrei,
10 min Cache) als grüne Fläche über die Karte — 1°-Gitter, bilinear geglättet,
Deckkraft nach Wahrscheinlichkeit. Für den Funkbetrieb ist das die Kehrseite der
MUF-Ebene: Wo das Oval steht, dämpft die Aurora die Kurzwelle.

Beide Flächen (Waldbrand, Polarlicht) werden wie die MUF-Ebene als Bildquelle
gezeichnet und dabei **zeilenweise auf Mercator zurückgerechnet**
(`gridImage.ts`), sonst wären sie in Nord-Süd-Richtung verzogen.

## Funkwetter und Kurzwellen-Ausbreitung

Die Kachel **Funkwetter** zeigt solaren Fluss, Sonnenflecken, A/K-Index,
Röntgenfluss, Polarlicht-Stufe und Störpegel sowie die Bandbewertungen für Tag
und Nacht (80/40, 30/20, 17/15, 12/10 m). Die Stufen stehen als **Wort** da
(Gut / Mäßig / Schlecht), die Farbe kommt nur dazu.

Die Kartenebene **„Ausbreitung (MUF)"** (Gruppe Funk) legt die höchste
brauchbare Frequenz als Fläche über die Welt; die Legende nennt statt Zahlen
gleich das oberste noch nutzbare Band. Gut zu sehen ist die Tag-/Nachtgrenze —
auf der Nachtseite sinkt die MUF auf Kurzwellen-Niveau.

Das Feld entsteht aus zwei Teilen: ein einfaches Modell aus Sonnenstand und
solarem Fluss füllt die großen Lücken (Ozeane), und die Messwerte von rund
30 aktuellen **Ionosonden** ziehen es entfernungsgewichtet auf die Wirklichkeit.
Das ersetzt kein Ionosphärenmodell und ist keine Vorhersage für eine bestimmte
Strecke — für den Überblick „welches Band trägt gerade wohin" reicht es.

### Bandampel für eine Strecke

Ein langes Antippen (bzw. die rechte Maustaste) auf der Karte bietet
**„Funkstrecke prüfen"**. Die App legt dann den Großkreis vom eigenen Standort
zum Punkt, tastet das MUF-Feld darauf ab und bewertet jedes Band:

* der **schwächste Punkt** der Strecke begrenzt die Verbindung;
* aus Länge und Sprungzahl folgt die Umrechnung von der Bezugsweite 3000 km auf
  die tatsächliche Sprungweite — ein kurzer Sprung braucht einen steilen Winkel
  und verträgt weniger Frequenz;
* der Sonnenstand entlang des Weges (und der K-Index) ergibt die untere Grenze,
  unter der die Dämpfung das Signal frisst;
* liegt die Strecke in der Dämmerungszone, steht das als Hinweis dabei.

Jede Bandzeile nennt Zustand **und Grund** im Klartext („über der MUF",
„Dämpfung zu stark", „dicht unter der MUF, unbeständig"). Das ist eine
Faustformel, kein VOACAP — Antenne, Leistung, Störpegel und Sporadic E kommen in
der Wirklichkeit dazu.

### Quellen und ihre Bitten

| Quelle | wofür | eingehalten |
| --- | --- | --- |
| [N0NBH / hamqsl.com](https://www.hamqsl.com/solar.html) | Kennzahlen, Bandbewertungen | Daten wechseln stündlich → **1 h Cache**, Quelle mit Rücklink genannt |
| [prop.kc2g.com](https://prop.kc2g.com/) (GIRO) | Ionosonden für die MUF-Ebene | 15 min Cache, Quelle im Ebenen-Menü genannt |
| NOAA SWPC | solarer Fluss, Kp-Index | gemeinfrei, trotzdem gecacht |

Umstellbar über `HAMQSL_URL` und `KC2G_URL`.

## Deployment

Läuft hinter einem eigenen Reverse-Proxy (TLS dort terminieren). Installation und
Update erfolgen mit **einem Befehl** aus diesem Repo (siehe `install.sh`, folgt).
Der Hono-Server liefert im Prod-Betrieb sowohl die API als auch das gebaute
PWA-Bundle aus.

## Lizenz

MIT
