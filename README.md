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
adsb.lol, aisstream.io).

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
| Verkehrsfluss | TomTom | nur mit gültigem `TOMTOM_KEY` |
| Verkehr / Pegel | Autobahn GmbH / PEGELONLINE | folgen dem Kartenausschnitt |
| Flugzeuge | adsb.fi (offenes ADS-B-Netz) | ab Zoom 6, aktualisiert alle 15 s |
| Schiffe | aisstream.io (AIS) | nur mit `AISSTREAM_KEY` |
| Amateurfunk | aprs.fi (APRS) | nur mit `APRSFI_KEY`, feste Rufzeichenliste |
| Tag/Nacht | selbst gerechnet | Dämmerungssaum, wandert minütlich mit |
| Markieren | eigene Punkte/Flächen | Benennung direkt beim Anlegen |

Flug- und Schiffspositionen werden nur geladen, solange ihre Ebene an ist, und
bewusst **nicht** offline gespeichert — sie veralten in Sekunden.

Flugzeuge tragen die Silhouette ihrer Musterklasse (Kleinflugzeug, Jet,
Großraum, Hubschrauber, Segelflug — aus der ADS-B-Kategorie abgeleitet), gefärbt
nach Zustand (in der Luft, am Boden, Notfall-Squawk). Das Popup zeigt Höhe samt
eingestellter Zielhöhe, Steig-/Sinkrate, Geschwindigkeiten (über Grund, IAS,
Mach), Kurs, Wind und Temperatur in Flughöhe, Squawk und Abstand. Halter und
**Flugroute** (Start- und Zielflughafen) holt `/api/aircraft/<icao>` beim
Antippen von [adsbdb.com](https://api.adsbdb.com) nach — frei und ohne Key.

## Wetter & Regenradar

* **Vorhersage**: `/api/weather/forecast` liefert aus Bright Sky (DWD) den
  Stundenverlauf (48 h) und eine daraus aggregierte 7-Tage-Übersicht. Die
  Detailansicht fasst die **nächsten 24 Stunden** in einem Diagramm mit
  gemeinsamer Zeitachse zusammen: Symbol, Temperaturkurve und darunter der
  Regen (Balken = Menge in mm, Linie = Wahrscheinlichkeit), dazu eine
  Klartext-Zeile („8,7 mm Regen erwartet · ab 13 Uhr · Spitze 3,1 mm/h").
  Darunter folgen die 7-Tage-Übersicht und die Luftqualität.
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

## Offline-Karten (PMTiles pro Bundesland)

Die App kann die Hintergrundkarte pro Bundesland offline vorhalten (Vektor-Kacheln
im OPFS des Browsers). Die PMTiles-Dateien erzeugst du einmalig:

```bash
scripts/build-maps.sh            # alle 16 Länder nach apps/api/maps/
scripts/build-maps.sh 04 11      # nur einzelne (Code)
```

Das Skript schneidet die Ausschnitte per `pmtiles extract` aus einer Planet-PMTiles
(Default: öffentliche Protomaps-Planet-Datei, Protomaps-Schema — passend zum Style;
`SOURCE`/`OUT_DIR`/`MAXZOOM` sind per Env übersteuerbar). Der API-Server liefert die
Dateien automatisch unter `/api/maps` aus. Dateien in `apps/api/maps/` sind
gitignored (große Binärdaten).

Die **Online**-Basiskarte kommt aus `VITE_MAP_PMTILES_URL` (Default: Protomaps-Demo;
in Produktion auf die eigene, gehostete Deutschland-PMTiles zeigen).

## Deployment

Läuft hinter einem eigenen Reverse-Proxy (TLS dort terminieren). Installation und
Update erfolgen mit **einem Befehl** aus diesem Repo (siehe `install.sh`, folgt).
Der Hono-Server liefert im Prod-Betrieb sowohl die API als auch das gebaute
PWA-Bundle aus.

## Lizenz

MIT
