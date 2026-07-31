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

Die Karte startet **ohne** Fachebenen — jede Ebene wird über einen eigenen Chip
zugeschaltet:

| Ebene | Quelle | Hinweis |
| --- | --- | --- |
| Warnungen | DWD-GeoServer (NINA-Skala) | mit Warnstufen-Filter |
| Regenradar | DWD RADOLAN-RV / RainViewer | Zeitleiste bis +2 h |
| Verkehrsfluss | TomTom | nur mit gültigem `TOMTOM_KEY` |
| Verkehr / Pegel | Autobahn GmbH / PEGELONLINE | folgen dem Kartenausschnitt |
| Flugzeuge | adsb.lol (offenes ADS-B-Netz) | ab Zoom 6, aktualisiert alle 15 s |
| Schiffe | aisstream.io (AIS) | nur mit `AISSTREAM_KEY` |
| Tag/Nacht | selbst gerechnet | Dämmerungssaum, wandert minütlich mit |
| Markieren | eigene Punkte/Flächen | Benennung direkt beim Anlegen |

Flug- und Schiffspositionen werden nur geladen, solange ihre Ebene an ist, und
bewusst **nicht** offline gespeichert — sie veralten in Sekunden.

## Wetter & Regenradar

* **Vorhersage**: `/api/weather/forecast` liefert aus Bright Sky (DWD) den
  Stundenverlauf (48 h) und eine daraus aggregierte 7-Tage-Übersicht. Die
  Detailansicht zeigt Symbole, eine Temperaturkurve, Regenbalken sowie
  Sonnenauf- und -untergang (lokal aus dem Sonnenstand gerechnet).
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
