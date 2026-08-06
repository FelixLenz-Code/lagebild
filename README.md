<div align="center">

# Lagebild

**Wetter, amtliche Warnungen, Verkehr und Nachrichten auf einer Karte —
und alles, worauf es ankommt, auch ohne Netz.**

[![CI](https://github.com/FelixLenz-Code/lagebild/actions/workflows/ci.yml/badge.svg)](https://github.com/FelixLenz-Code/lagebild/actions/workflows/ci.yml)
[![Lizenz: PolyForm Noncommercial](https://img.shields.io/badge/Lizenz-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)
![Node 20+](https://img.shields.io/badge/Node-20%2B-5b9e4a)
![PWA](https://img.shields.io/badge/PWA-offline--first-1d4e73)
![ohne Konto, ohne Tracker](https://img.shields.io/badge/ohne%20Konto-ohne%20Tracker-5b5b60)

</div>

![Die Lagekarte mit Wetter, Zählern im Ausschnitt, Abfahrten und Funkwetter](docs/screenshots/uebersicht.png)

## Worum es geht

Wer draußen unterwegs ist, braucht selten *eine* Information — sondern das
Zusammenspiel: Zieht das Gewitter über den Grat? Steht die Bahn? Warnt der
Katastrophenschutz gerade? Und wie komme ich hier weg, wenn das Netz weg ist?

**Lagebild** legt diese Dinge übereinander auf eine Karte und macht die
wichtigsten davon **offline verfügbar**. Route, Suche, Höhenprofil und
Notfallblatt rechnen ausschließlich auf dem Gerät — es gibt keinen
Routing-Dienst im Hintergrund, der ausfallen könnte. Pro Bundesland lädt man
dafür einmal ein Paket herunter.

Fokus ist Deutschland, Quellen sind überwiegend amtlich (DWD, BBK/NINA,
Autobahn GmbH, PEGELONLINE, BfS) oder frei (OpenStreetMap, transitous.org).
Kein Konto, keine Anmeldung, keine Tracker.

## Was drin ist

- 🗺️ **27 Kartenebenen** — Unwetter- und Behördenwarnungen, Regenradar mit
  Vorhersage bis +2 h, Wind, Pegel, Verkehr, Blitze, Lawinenlage, Flugzeuge,
  Schiffe, Waldbrandgefahr, Polarlicht, Rettungspunkte …
- 🧭 **Navigation komplett offline** — Auto, Rad, zu Fuß, mit Abbiegeverboten,
  deutschen Ansagen, bis zu drei Varianten, Zwischenzielen und Höhenprofil
- 🔎 **Suche ohne Netz** — Adressen mit Hausnummer, Orte, Punkte („Apotheke"),
  Koordinaten in fünf Schreibweisen, dazu **Rettungs- und Notfallpunkte**
- 🚆 **ÖPNV mit Gleisangabe** — Verbindungen von transitous.org, jede Fahrt mit
  Ein- und Ausstieg, Steig und kurzfristigem Gleiswechsel
- 🆘 **Notfallblatt** — Nummern, die fünf W-Fragen, der eigene Standort in der
  Schreibweise der Leitstelle, nächste Anlaufstellen. Ohne Netz, druckbar
- ✏️ **Einzeichnen und Messen** — Punkte, Linien, Flächen, GPX/KML/GeoJSON
  einlesen, Spur aufzeichnen, Karte als Link teilen
- 📻 **Funkwetter** — MUF-Karte, Bandampel für eine Strecke, APRS-Ziele
- 📱 **Installierbare PWA** — läuft im Browser, auf dem Homescreen und als
  Diashow auf einem Lagemonitor

## Ein Blick hinein

| | |
| --- | --- |
| <img src="docs/screenshots/suche-rettungspunkte.png" alt="Suche nach Rettungspunkten" width="330"> | <img src="docs/screenshots/oepnv-gleise.png" alt="ÖPNV-Verbindung mit Gleisangaben" width="330"> |
| **Rettungspunkte suchen.** Das Wort genügt, die Kennung vom Schild auch („DA-703", „4915"). Betreiber, Entfernung, und von hier direkt anfahrbar. | **ÖPNV mit Steig.** Jede Fahrt nennt Ein- und Ausstieg mit Gleis; ein kurzfristiger Wechsel steht durchgestrichen daneben. |
| <img src="docs/screenshots/notfallblatt.png" alt="Notfallblatt mit Notrufnummern" width="330"> | <img src="docs/screenshots/ebenen.png" alt="Ebenen und ihre Quellen in den Einstellungen" width="330"> |
| **Notfallblatt.** Nummern, die fünf W-Fragen und der eigene Standort so, wie die Leitstelle ihn hören will. Funktioniert ohne Netz. | **Jede Ebene nennt ihre Quelle.** Was man nicht braucht, verschwindet aus dem Menü — die Karte bleibt lesbar. |

## Zwei Gestalten, nicht eine gestauchte

Am Rechner stehen Karte und Kacheln nebeneinander. Auf schmalen Geräten
(unter 900 px) ist die App **keine zusammengeschobene Schreibtisch-Ansicht**,
sondern hat einen eigenen Aufbau: schlanke Kopfzeile mit Ort, die Karte über
die ganze Fläche, und unten eine Leiste — **Karte · Suche · Lage · ÖPNV ·
Mehr**. Die Karte bleibt dabei immer eingehängt; die anderen Reiter legen sich
darüber, damit Ausschnitt und Ebenen beim Wechseln erhalten bleiben.

„Lage" und „ÖPNV" sind dort eigene Seiten und zeigen mehr als die Kachel: die
Warnungen im Klartext, alle Halte in der Nähe mit ihren Abfahrten. Unter „Mehr"
liegt, was am Rechner in der Kopfzeile steht — Notfallblatt, Kompass, Spur,
Teilen, Offline-Regionen, Einstellungen.

## Auf einem Server installieren

Ein Befehl richtet ein und aktualisiert — dasselbe Skript für beides:

```bash
curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/lagebild/main/install.sh | bash
```

Wer nicht gern ein Skript aus dem Netz in eine Shell schüttet (guter Reflex),
lädt es erst herunter und liest es:

```bash
curl -fsSL https://raw.githubusercontent.com/FelixLenz-Code/lagebild/main/install.sh -o install.sh
less install.sh
bash install.sh
```

Der Installer legt an: `/opt/lagebild` mit Quellcode und gebautem Bundle, einen
Systemnutzer `lagebild` ohne Login, und den Dienst `lagebild.service` (Start
beim Hochfahren, Neustart nach Absturz). Er fragt dabei die drei optionalen
Schlüssel und das Passwort ab — vorhandene Werte zeigt er maskiert, Enter
behält sie, ein `-` löscht sie. Voraussetzungen: Linux mit systemd, Node.js 20
oder neuer, `git`, `curl` und `sudo`.

**Beim zweiten Aufruf ist es ein Updater**: neuen Stand holen, bauen, Dienst
durchstarten. Schlüssel, Passwort und heruntergeladene Offline-Pakete bleiben
unangetastet, die Abfrage dient dann zum Ändern.

| | |
| --- | --- |
| Zustand | `systemctl status lagebild` |
| Protokoll | `journalctl -u lagebild -f` |
| Konfiguration | `/opt/lagebild/apps/api/.env` |
| Anderes Ziel | `LAGEBILD_DIR=/srv/lagebild bash install.sh` |

TLS gehört davor in einen Reverse-Proxy — sonst geht `APP_PASSWORD` im Klartext
über die Leitung.

## Loslegen (Entwicklung)

```bash
pnpm install
cp apps/api/.env.example apps/api/.env     # optionale Schlüssel, Passwort
pnpm dev                                   # API :8787 + Web :5173
```

Danach http://localhost:5173 öffnen. Ohne jeden Schlüssel läuft alles außer
Verkehrsfluss (TomTom), Schiffen (aisstream.io) und Amateurfunk (aprs.fi) —
diese Ebenen blenden sich von selbst aus.

```bash
pnpm build          # alle Pakete bauen
pnpm typecheck      # Typprüfung
pnpm check          # Prüfläufe ohne Daten und ohne Netz
```

## Offline-Pakete

Die Offline-Fähigkeit hängt an drei Dateien je Bundesland, die der Browser über
den „Offline"-Knopf in den OPFS lädt:

| Datei | Inhalt | Bremen | Hessen |
| --- | --- | --- | --- |
| `<code>.pmtiles` | Hintergrundkarte (Vektorkacheln) | 22 MB | — |
| `<code>.route` | Routing-Graph mit Abbiegeverboten | 1,9 MB | 35 MB |
| `<code>.search` | Suchindex: Orte, Straßen, POIs, Hausnummern | 1,6 MB | 18 MB |

```bash
scripts/build-routing.mjs           # alle 16 Länder (lädt die OSM-Auszüge)
scripts/build-routing.mjs 04 11     # nur einzelne (Ländercode)
scripts/build-maps.sh 04 11         # Hintergrundkarten dazu
scripts/build-terrain.mjs 04        # Höhendaten für Profil und Höhenlinien
```

Gebaut wird aus den Geofabrik-Auszügen; der API-Server liefert die fertigen
Dateien unter `/api/maps` aus. Große Länder brauchen ein paar Minuten und
mehrere GB Heap — das Skript startet sich dafür selbst neu. Die Dateien sind
gitignored.

## Datenquellen

| Thema | Quelle | Zugang |
| --- | --- | --- |
| Wetter, Vorhersage, Regenradar | Bright Sky / DWD | frei |
| Unwetterwarnungen | DWD-GeoServer | frei |
| Behördenwarnungen | BBK / NINA | frei |
| Pegelstände | PEGELONLINE (WSV) | frei |
| Verkehrsmeldungen, Rastplätze | Autobahn GmbH | frei |
| Bahn / ÖPNV, Haltestellen, Fahrzeuge | transitous.org (MOTIS) | frei |
| Karte, Routing, Suche, Rettungspunkte | OpenStreetMap (+ Overpass) | ODbL |
| Luftqualität, Wind | Open-Meteo | frei |
| Strahlung (ODL) | Bundesamt für Strahlenschutz | frei |
| Waldbrandgefahr, Pollen | DWD | frei |
| Lawinenlage | EAWS-Warndienste | frei |
| Blitze | Blitzortung.org | frei |
| Erdbeben | USGS | gemeinfrei |
| Funkwetter, Polarlicht | NOAA SWPC | gemeinfrei |
| Satellitenfeuer | NASA FIRMS | frei |
| Flugzeuge | adsb.fi, adsbdb.com | frei |
| Nachrichten | Tagesschau | frei |
| Verkehrsfluss | TomTom | `TOMTOM_KEY` |
| Schiffe (AIS) | aisstream.io | `AISSTREAM_KEY` |
| Amateurfunk (APRS) | aprs.fi | `APRSFI_KEY` |

## Grundsätze

- **Offline zuerst.** Was im Ernstfall zählt, darf nicht am Netz hängen.
  Routing, Suche, Höhenprofil und Notfallblatt rechnen auf dem Gerät.
- **Nichts erfinden.** Fehlt eine Angabe, bleibt die Zeile leer — statt eine
  plausible Zahl hinzuschreiben. Jede Ebene nennt ihre Quelle und ihr Alter.
- **Farbe ist nie die einzige Information.** Warnstufen, Verkehrsmittel und
  Zustände stehen zusätzlich im Klartext.
- **Rücksicht auf gespendete Dienste.** Serverseitiger Cache, gerasterte
  Anfragen, keine Abrufe für ausgeschaltete Ebenen.
- **Kein Konto, keine Tracker.** Der Server ist ein zustandsloser Proxy;
  eigene Daten (Markierungen, Ziele, Spuren) bleiben im Browser.

## Aufbau

Monorepo mit pnpm-Workspaces, durchgehend TypeScript:

| Paket | Zweck |
| --- | --- |
| `apps/web` | React-PWA (Vite, MapLibre). Karte, Kacheln, Offline-Worker. |
| `apps/api` | Hono-Proxy. Normalisiert Quellen, umgeht CORS, cached kurz. |
| `packages/shared` | Gemeinsame Datentypen. |
| `scripts` | Paketbau (Routing, Karten, Gelände) und Prüfläufe. |

Statt eines Testrahmens liegen die Prüfungen als eigenständige Node-Skripte
bei — sie lesen dieselben Module wie die App:

| Befehl | prüft | braucht |
| --- | --- | --- |
| `pnpm check:import` | GPX/KML/KMZ/GeoJSON-Leser, Maße | nichts |
| `pnpm check:auth` | Passwortschutz, Bremse, Cookie | nichts |
| `pnpm check:offline` | Graph, Router, Suchindex | gebautes Regionspaket |
| `pnpm check:via` | Zwischenziele, Nähte, Ausweichkanten | gebautes Regionspaket |
| `pnpm check:terrain` | Höhenraster gegen bekannte Höhen | gebautes Höhenpaket |

## Konfiguration

Alles über `apps/api/.env` (Vorlage: `.env.example`):

| Variable | Wirkung |
| --- | --- |
| `APP_PASSWORD` | Gemeinsames Passwort vor `/api/*`. Leer = offen. Nur mit HTTPS sinnvoll. |
| `CACHE_TTL_SECONDS` | Wie lange Proxy-Antworten frisch bleiben (Standard 300). |
| `WEB_ROOT` | Gebautes PWA-Bundle, das der Server mit ausliefert. |
| `MAPS_DIR` | Ablage der Offline-Pakete für `/api/maps`. |
| `TOMTOM_KEY`, `AISSTREAM_KEY`, `APRSFI_KEY` | Schalten die jeweilige Ebene frei. |
| `VITE_MAP_PMTILES_URL` | Online-Basiskarte (Bauzeit). Für den Betrieb auf eine eigene PMTiles zeigen. |

Das Passwort sperrt **nur den Server**, nie das Gerät: Ein Netzfehler ändert
nichts, entsperrt bleibt entsperrt — sonst stünde man ohne Empfang vor einem
Passwortfeld, obwohl alle Daten längst im Gerät liegen.

## Betrieb von Hand

Für alles außer Linux-mit-systemd (oder wenn der Installer nicht passt): Ein
einziger Hono-Prozess liefert API **und** PWA-Bundle aus, zustandslos.

```bash
pnpm build
pnpm start                              # WEB_ROOT muss auf apps/web/dist zeigen
```

TLS gehört davor in einen Reverse-Proxy — `APP_PASSWORD` geht sonst im Klartext
über die Leitung.

## Hinweis zur KI-Unterstützung

Diese Software wurde vollständig mithilfe von Claude (einem KI-Assistenten von
Anthropic) entwickelt. Der Autor hat die Anforderungen definiert, Entscheidungen
getroffen und das Ergebnis geprüft — der Code selbst wurde durch den Dialog mit
der KI generiert.

## Haftungsausschluss

Die Software wird so bereitgestellt, wie sie ist (as-is), ohne jegliche Garantie
auf Korrektheit, Vollständigkeit oder Eignung für einen bestimmten Zweck. Der
Autor übernimmt keinerlei Haftung für Schäden, Datenverluste oder sonstige
Probleme, die durch die Verwendung dieser Software entstehen. Die Nutzung
erfolgt auf eigene Verantwortung.

Das gilt ausdrücklich auch für die angezeigten Daten: Warnungen, Wetter, Pegel,
Verkehr und Fahrpläne stammen von Dritten, können verspätet, unvollständig oder
falsch sein. **Diese App ist kein Ersatz für die amtlichen Warnkanäle** und
keine Grundlage für Entscheidungen über Leib und Leben. Im Notfall gilt die 112.

## Lizenz

© 2026 Felix Lenz.

Dieses Projekt steht unter der
[PolyForm Noncommercial License 1.0.0](LICENSE). Du darfst es nutzen, ändern
und weitergeben, solange es **nicht kommerziell** geschieht und der Urheber
genannt bleibt. Den vollständigen Text findest du in [LICENSE](LICENSE) sowie
unter <https://polyformproject.org/licenses/noncommercial/1.0.0/>.

Die **Daten** gehören ihren Quellen und stehen unter deren eigenen Bedingungen —
Karte, Routing und Suche stammen aus OpenStreetMap (© OpenStreetMap-Mitwirkende,
[ODbL](https://opendatacommons.org/licenses/odbl/)).
