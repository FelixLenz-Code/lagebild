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
pnpm check      # Prüfläufe ohne Daten (Datei-Import, Maße)
```

### Prüfläufe

Statt eines Testrahmens liegen die Prüfungen als eigenständige Skripte bei —
sie lesen dieselben Module wie die App und laufen unter Node:

| Befehl | prüft | braucht |
| --- | --- | --- |
| `pnpm check:import` | GPX/KML/KMZ/GeoJSON-Leser, Ausdünnen, `geo.ts` | nichts |
| `pnpm check:offline` | Graph, Router, Suchindex, Wegenetz | gebautes Regionspaket |
| `pnpm check:via` | Zwischenziele, Naht der Abschnitte, Ausweichkanten | gebautes Regionspaket |
| `pnpm check:terrain` | Höhenraster gegen bekannte Höhen | gebautes Höhenpaket |

`pnpm check` läuft in der CI bei jedem Anstoß mit. Die drei anderen brauchen
ein gebautes Paket und laufen deshalb im eigenen Ablauf **„Offline-Pakete"**
(`.github/workflows/pakete.yml`): wenn sich der Paketbau oder der Offline-Teil
der App ändert, einmal wöchentlich und auf Knopfdruck. Er baut Bremen aus dem
Geofabrik-Auszug und prüft damit — Auszug und Höhenkacheln liegen im
Zwischenlager der CI, weil für einen Prüflauf der Aufbau der Daten zählt und
nicht ihr Alter.

Lokal genauso:

```bash
node scripts/build-routing.mjs 04
node scripts/build-terrain.mjs --out apps/api/maps 04
pnpm check:pakete
```

## Passwort vor dem Server

Der Server kann mit **einem gemeinsamen Passwort** geschützt werden — damit
nicht jeder, der die Adresse kennt, die Proxy-Routen und die Offline-Pakete auf
deine Rechnung benutzt:

```bash
# apps/api/.env
APP_PASSWORD=…        # leer = offen, alles läuft wie bisher
```

Geschützt ist `/api/*` bis auf `/api/health` und `/api/auth/*`. **Das statische
Bundle bleibt frei** — sonst könnte sich die PWA weder installieren noch
aktualisieren, und ein gesperrtes Gerät bekäme eine leere Seite statt des
Passwortfelds.

**Der Server bleibt zustandslos.** Der Schlüssel für das Merkmal wird aus dem
Passwort abgeleitet (scrypt mit festem Salz) und nirgends gespeichert — es gibt
keine Sitzungsverwaltung. Angenehme Nebenwirkung: **Passwort ändern meldet alle
Geräte ab**, ganz ohne Buchführung.

### Kein Aussperren unterwegs

Das ist der Teil, an dem so etwas üblicherweise scheitert. Drei Regeln:

1. Das Merkmal liegt in einem **HttpOnly-Cookie** mit 400 Tagen Laufzeit und
   wird bei jeder Anfrage erneuert, die älter als ein Tag ist. Es läuft also
   nicht ab, solange die App benutzt wird.
2. Ob die App entsperrt ist, entscheidet ein **lokaler Merker**, nicht eine
   Anfrage an den Server. Ein Netzfehler ändert daran nie etwas.
3. Nur eine **echte Antwort mit 401** sperrt wieder zu. Alle rund vierzig
   Abrufe laufen durch ein `getJson`, die Paketdownloads prüfen es zusätzlich
   selbst — es gibt genau diese eine Stelle.

Abgesperrt wird nur von Hand, in den Einstellungen unter „App", mit einer
Rückfrage, die es beim Namen nennt: *ohne Verbindung kommst du danach nicht
wieder hinein*.

Nachgeprüft mit `pnpm check:auth` (Merkmal, Passwortwechsel, Bremse gegen
Durchprobieren, Cookie) und im Browser gegen das gebaute Bundle: Schloss →
entsperren → neu laden bleibt offen → **offline neu laden bleibt offen** →
eingespielte 401 sperrt zu.

**Der Schutz taugt nur mit HTTPS** — sonst geht das Passwort im Klartext über
die Leitung. Bei der Installation über `install.sh` übernimmt das Caddy.

## Kartenebenen

Die Karte startet **ohne** Fachebenen. Alle Ebenen liegen im Ausklapp-Menü
**„Ebenen"** oben links, gruppiert in der Reihenfolge **Wetter, Gefahren,
Verkehr, Lage, Funk** (vom Alltäglichen zum Besonderen), mit Zähler der aktiven
Ebenen und „Alle aus"; das Einzeichnen-Menü liegt als eigener Knopf daneben:

| Ebene | Quelle | Hinweis |
| --- | --- | --- |
| Unwetterwarnungen | DWD-GeoServer | Gruppe Wetter, mit Warnstufen-Filter |
| Behördenwarnungen | BBK / NINA | MoWaS, KATWARN, BIWAPP, Polizei, Hochwasser |
| Feuer (Satellit) | NASA FIRMS (VIIRS) | Wärmeanomalien der letzten 24 h |
| Strahlung (ODL) | Bundesamt für Strahlenschutz | ~1700 Sonden, stündlich |
| Regenradar | DWD RADOLAN-RV / RainViewer | Zeitleiste bis +2 h |
| Wind | Open-Meteo | animiertes Strömungsbild (10 m über Grund) |
| Verkehrsfluss | TomTom | nur mit gültigem `TOMTOM_KEY` |
| Verkehrsmeldungen | Autobahn GmbH | folgt dem Kartenausschnitt |
| Pegel | PEGELONLINE | Gruppe Gefahren, mit Verlauf im Popup |
| Rastplätze & Laden | Autobahn GmbH | Stellplätze und Ladepunkte, ab Zoom 8 |
| Webcams | Foto-Webcam.eu | Standorte mit Link, ohne Bild |
| Flugzeuge | adsb.fi (offenes ADS-B-Netz) | ab Zoom 6, aktualisiert alle 15 s |
| Schiffe | aisstream.io (AIS) | nur mit `AISSTREAM_KEY` |
| Amateurfunk | aprs.fi (APRS) | nur mit `APRSFI_KEY`, feste Rufzeichenliste |
| Busse & Bahnen | transitous.org (MOTIS) | Fahrzeuge in Bewegung, ab Zoom 10 |
| Notfallpunkte | Offline-Suchindex (OSM) | Klinik, Apotheke, Polizei, Feuerwehr — ohne Netz |
| Rettungspunkte | OpenStreetMap (Overpass) | nummerierte Schilder für den Notruf, ab Zoom 11 |
| Blitze | Blitzortung.org | Entladungen der letzten 30 Minuten |
| Erdbeben | USGS | letzte Woche, ab Stärke 2,5 |
| Waldbrandgefahr | DWD | Stufe 1–5, Deutschland |
| Polarlicht | NOAA SWPC (OVATION) | Wahrscheinlichkeit weltweit |
| Tag/Nacht | selbst gerechnet | Dämmerungssaum, wandert minütlich mit |
| Einzeichnen | eigene Punkte/Linien/Flächen | Werkzeuge, Messen und Datei-Import (siehe unten) |

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

## Warnstreifen am eigenen Standort

Gilt am **eigenen Standort** eine ernste Warnung, steht sie als farbiger
Streifen zwischen Kopfzeile und Karte — mit Stufe, Herkunft, Schlagzeile und
vor allem der **Handlungsanweisung**; ein Tipp öffnet die Liste.

Zwei bewusst unterschiedliche Regeln: Vom DWD zählen nur `severe` und
`extreme` — sonst wäre der Streifen bei jedem Wind zu sehen und würde
ignoriert. **Behördenwarnungen** (MoWaS, KATWARN, Polizei …) stehen unabhängig
von ihrer eingetragenen Stufe drin, weil es sie nur gibt, wenn tatsächlich
etwas vorgefallen ist.

Abgefragt wird ein kleines Rechteck **um den Standort**, unabhängig vom
Kartenausschnitt und von den Ebenen — sonst verschwände die Warnung, sobald man
die Karte verschiebt. Ob eine Fläche den Punkt wirklich überdeckt, entscheidet
danach ein Strahlverfahren (`pointInGeometry`). Wegklicken gilt für die
laufende Sitzung; beim nächsten Start ist die Warnung wieder da, solange sie
gilt.

## Koordinaten in allen Schreibweisen

Das Standort-Blatt zeigt die eigene Position in **Dezimalgrad**, **Grad/
Dezimalminuten**, **Grad/Minuten/Sekunden**, **UTM** und **MGRS** — jede Zeile
kopiert sich per Tipp. Leitstellen verlangen Grad und Dezimalminuten, Behörden
und Hilfsorganisationen arbeiten mit UTM oder MGRS, Apps wollen Dezimalgrad.

Die Umrechnung steht in `coords.ts` und kommt ohne Bibliothek aus
(Krüger-Reihe vierter Ordnung auf dem WGS84-Ellipsoid), inklusive der
Sonderzonen für Norwegen und Spitzbergen. Geprüft gegen `pyproj` an sieben
Punkten von Bremen bis Sydney: Abweichung unter einem Zentimeter, Rückrechnung
im Millimeterbereich.

Die **Suche** nimmt Koordinaten ebenfalls entgegen — „52.5163, 13.3777",
„N 52 30.978 E 13 22.662", „33U 389918 5819702" oder „33U UU 89918 19702".
Passt die Eingabe, steht die Koordinate als eigener Treffer ganz oben und lässt
sich wie jedes andere Ziel anfahren.

## Meine Orte

Der Warnstreifen oben gilt für den **eigenen Standort**. Wer unterwegs ist, will
aber auch wissen, ob zu Hause oder bei den Eltern etwas los ist — dafür gibt es
**„Meine Orte"**: bis zu acht beobachtete Punkte, jeder mit derselben Prüfung
wie am Standort (DWD ab `severe`, Behördenwarnungen in jeder Stufe, Flächen
per Strahlverfahren geprüft). Aufgenommen werden sie über das Kartenmenü („Ort
beobachten") oder als aktueller Standort.

Die Kachel zeigt je Ort einen Punkt (grün = ruhig) und die Schlagzeile; das
Blatt nennt Stufe, Herkunft und **Handlungsanweisung** und führt in die
Warnliste. Abgefragt wird **je Ort ein eigenes Rechteck**, nicht ein
gemeinsames: Bei Orten in Bremen und München wäre das gemeinsame Rechteck halb
Deutschland, und die DWD-Warnabfrage liefert national über 20.000 Flächen.

## Karte teilen

Der Knopf mit dem Verzweigungssymbol rechts an der Karte öffnet **„Karte
teilen"**:

- **Als Link** — Ausschnitt und eingeschaltete Ebenen stehen im **Hash** der
  Adresse (`#karte=53.08360,8.81370,11.0&ebenen=warnings,radar`). Der Hash geht
  nie an einen Server; die App bleibt eine reine Browseranwendung. Wer den Link
  öffnet, landet auf demselben Ausschnitt mit denselben Ebenen — die Ortung
  beim Start wird dann übersprungen, sonst spränge die Karte sofort zur eigenen
  Straße. Danach räumt die App den Hash wieder weg.
- **Als Bild** — ein Abzug der Leinwand. Dafür läuft die Karte mit
  `preserveDrawingBuffer`, sonst gibt WebGL den Puffer nach jedem Bild frei und
  das Ergebnis wäre schwarz. Standort-, Start- und Zielmarke liegen als HTML
  neben der Leinwand und werden nachträglich daraufgemalt.

## Notfallblatt

Erreichbar über das Standort-Blatt. Gedacht für den Augenblick, in dem man den
Notruf wählt, und **vollständig ohne Netz** nutzbar:

- **112** groß, dazu 110, 116117 und die Telefonseelsorge — alles als
  Wählen-Verweis;
- **die fünf W** (Wo, Was, Wie viele, Welche Verletzungen, Warten);
- die **eigene Position** in allen Schreibweisen, mit der Zeile „Für die
  Leitstelle vorlesen" in Grad und Dezimalminuten — so wollen es Leitstellen;
- die nächsten **Rettungspunkte** und je Art die nächste **Anlaufstelle**
  (Klinik, Apotheke, Arzt, Polizei, Feuerwehr) aus dem Offline-Suchindex, jede
  direkt anfahrbar;
- die **Giftinformationszentralen** — bewusst als Liste der Städte und nicht
  nach Bundesland zugeordnet: Die Zuständigkeiten überschneiden sich, und eine
  falsche Zuordnung wäre im Ernstfall schlimmer als eine Zeile mehr zum Lesen.

Das Blatt lässt sich **drucken** (eigenes Druck-Stylesheet: Kopfzeile, Karte
und Kacheln fallen weg). Wer es einmal ausdruckt, hat es auch dann, wenn das
Gerät leer ist.

## Kompass und Peilung

Das Standort-Blatt öffnet **„Kompass und Peilung"**; ein Ziel setzt das
Kartenmenü (langes Antippen) mit **„Peilung hierher"**. Gedacht ist das fürs
Anlaufen eines Punktes **ohne Karte im Blick** — Rettungspunkt im Wald,
Sammelplatz im Nebel, Ausrichten einer Richtantenne.

Deshalb ist die größte Zahl nicht die Peilung, sondern **wie weit man sich
drehen muss** („135° nach links drehen"). Darunter stehen Peilung mit
Himmelsrichtung, Entfernung, die eigene Blickrichtung und die Zielkoordinate in
Grad/Dezimalminuten. Die Rose dreht sich gegen die Blickrichtung, oben ist immer
„vorn"; die Nadel zeigt zum Ziel.

**Punkt berechnen** (Wegpunkt-Projektion): „von hier 300 m auf 240°" ergibt
einen neuen Punkt, der sich sofort als Markierung anlegen lässt. Gerechnet auf
dem Großkreis, damit es auch über Kilometer stimmt — so kommen Ortsangaben über
Funk oder von einer Papierkarte.

**Zur Nordrichtung:** `deviceorientationabsolute` und Safaris
`webkitCompassHeading` liefern rechtweisend Nord. Das gewöhnliche
`deviceorientation` liefert je nach Gerät nur eine relative Ausrichtung — dann
sagt das Blatt das ausdrücklich, statt eine Genauigkeit vorzutäuschen, die es
nicht gibt. iOS verlangt ab Version 13 eine Erlaubnis; dafür steht ein Knopf
bereit. Die Rohwerte zappeln um mehrere Grad und werden deshalb geglättet —
**über den Nullpunkt hinweg**, sonst läge das Mittel von 359° und 1° bei 180°.

## Sichern und zurückholen

Alle eigenen Daten liegen im **localStorage dieses Browsers** — Markierungen,
Spuren, beobachtete Orte, gespeicherte Ziele, Karten für die Diashow,
Rufzeichen, Einstellungen. Unter **Einstellungen → App** schreibt „Sicherung
speichern" alles in eine JSON-Datei; „Sicherung einspielen" holt sie zurück,
wahlweise **dazulegen** (Vorhandenes bleibt, Doppel werden über die `id`
erkannt) oder **ersetzen**.

Nicht dabei sind der Zwischenspeicher der Fachdaten und die Offline-Pakete —
beides ist jederzeit wieder ladbar und würde die Datei nur aufblähen.

Der Offline-Bildschirm zeigt außerdem **freien Speicher und Akkustand**. Das
sind beim Packen vor der Tour die zwei Zahlen, auf die es ankommt. Beides gibt
nicht jeder Browser her; fehlt es, bleibt die Zeile weg statt zu raten.

## Spur aufzeichnen

Der Knopf mit der Wegelinie in der Kopfzeile öffnet die **Spuraufzeichnung**.
Zweck ist nicht der Sportnachweis, sondern der **Rückweg**: Wer im Wald oder im
Nebel umkehren muss, folgt der eigenen Spur zurück. Während der Aufzeichnung
liegt sie als Linie auf der Karte (Startpunkt gefüllt, Endpunkt hohl), der
Knopf blinkt rot.

Gespeicherte Spuren lassen sich einzeln auf die Karte legen, als **GPX**
herunterladen (das Format, das jede Wander- und Radsoftware liest) und mit
„Zum Start zurück" direkt in die Routenplanung geben. Alles bleibt im Browser.

**Ausdünnung:** Beim Stehen liefert die Ortung weiter Punkte, die nur um die
Messgenauigkeit herumspringen. Übernommen wird deshalb nur, was mindestens 8 m
entfernt oder 30 s später kommt — sonst wüchse die Spur ins Unendliche und die
Länge wäre zu groß.

## Einzeichnen: Werkzeuge, Messen, Dateien

Der Knopf **„Einzeichnen"** auf der Karte öffnet ein Menü mit allem, was man
selbst auf die Karte bringt — es ist bewusst so geschnitten, dass weitere
Werkzeuge hineinwachsen:

- **Werkzeuge**: Punkt setzen, **Linie zeichnen**, Fläche zeichnen, **Messen**.
- **Datei**: Tour oder Punkte einlesen (GPX, KML, KMZ, GeoJSON).
- **Meine Markierungen**: Liste mit Maßen, Umbenennen, Löschen, „auf der Karte
  zeigen", **einzeln aus- und einblenden** und **Ausgabe als GPX bzw. GeoJSON**
  (einzeln oder alles zusammen).

Die ganze Ebene schaltet das Menü **„Ebenen" → „Meine Markierungen"**. Sie ist
die einzige Ebene, die **eingeschaltet startet**: Wer etwas eingezeichnet hat,
soll es beim nächsten Öffnen sehen. Einzelne Markierungen lassen sich in der
Liste mit dem Auge ausblenden — sie bleiben gespeichert und in der Suche
auffindbar, liegen nur nicht auf der Karte.

**GPX kennt keine Flächen**: Ein Gebiet wird darin zur geschlossenen Linie. Wer
die Fläche als Fläche braucht, nimmt GeoJSON — deshalb stehen beide Ausgaben
nebeneinander.

Beim Anlegen wird gleich die **Farbe** gewählt, bei Punkten zusätzlich ein
**Symbol** (Fahne, Gefahr, Erste Hilfe, Sammelplatz, Wasser, Feuer, Antenne …).
Beides lässt sich in der Liste nachträglich ändern. Die Palette steht in
`drawStyle.ts` — acht kräftige Töne, die auf heller wie dunkler Karte tragen,
und zwölf Symbole; Karte und Bedienung lesen dieselbe Quelle. Die zuletzt
gewählte Aufmachung bleibt vorgeschlagen, damit eine Reihe gleichartiger Punkte
schnell gesetzt ist.

Das laufende Werkzeug bekommt eine **eigene Leiste auf der Karte** statt eines
Bereichs im Menü. Der Grund ist handfest: Wer misst, tippt auf die Karte — und
dabei fällt jedes Ausklappmenü zu, samt der Werte, auf die es ankommt.

### Messen

Punkte antippen; die Leiste zeigt laufend die **Strecke** und ab drei Punkten
die **eingeschlossene Fläche**. Beides lässt sich als Markierung sichern (Linie
bzw. Fläche), sonst ist die Arbeit mit dem nächsten Werkzeug weg. Die Fläche
kommt aus dem sphärischen Exzess (`geo.ts`) und stimmt deshalb auch bei großen
Gebieten; die Liste der Markierungen nennt zu jeder Linie ihre Länge und zu
jeder Fläche Größe und Umfang.

### Dateien einlesen

Gelesen werden **GPX, KML, KMZ und GeoJSON** — Datei auswählen oder einfach auf
das Fenster ziehen. Damit lassen sich fertige Touren (Komoot, Outdooractive),
Punktsammlungen aus Google Earth und Übersichten aus einer Lagekarte öffnen:

- **Linien** (`trk`, `rte`, `LineString`, `gx:Track`) landen **doppelt**: als
  Markierung der Art „Linie" (dauerhaft auf der Karte, mehrere gleichzeitig,
  umbenennbar) **und** als Spur (GPX-Ausgabe, „Zum Start zurück"). Beide Wege
  sollen offenstehen; deshalb wird die Spur nach dem Einlesen nicht zusätzlich
  eingeblendet — sie läge deckungsgleich unter der Markierung.
- **Einzelne Punkte** (`wpt`, `Point`) und **Flächen** (`Polygon`) werden zu
  eigenen Markierungen. Sie erscheinen dadurch in der Suche als Ziel und lassen
  sich anfahren.

Vor der Übernahme steht eine **Zusammenfassung** — fremde Dateien enthalten oft
mehr, als man erwartet, und niemand soll seine Markierungen ungefragt
vollgeschüttet bekommen. Alles bleibt auf dem Gerät; es geht nichts an einen
Server.

Der Leser ist wie der Rest des Projekts selbst geschrieben (kein Paket) und
kommt ohne DOM-Schnittstellen aus — deshalb läuft er unverändert im Prüfskript:

```bash
apps/api/node_modules/.bin/tsx scripts/check-import.mts
```

Eigenheiten, die dabei abgedeckt sind: Namensräume (`kml:Placemark`), CDATA,
Entitäten, `ISO-8859-1`, mehrere Abschnitte in einem Track (die **nicht**
zusammengezogen werden — sonst zöge sich eine gerade Linie über eine Pause),
`MultiGeometry` und gepackte KMZ. Sehr lange Aufzeichnungen werden nach
Douglas-Peucker ausgedünnt, wobei die Toleranz **verdoppelt** wird, bis die
Spur unter 4000 Stützpunkte passt: „jeder n-te Punkt" wäre einfacher, verdreht
den Verlauf aber messbar (13 m statt 4 m Abweichung bei einer 33-km-Spur).

## Einstellungen und Quellen

Das Zahnrad in der Kopfzeile öffnet ein Blatt mit drei Reitern — hier wächst
künftig alles hinein, was Einstellung ist:

- **Diashow**: gespeicherte „Karten" (Ebenen-Zusammenstellungen) in eine
  Reihenfolge bringen und ablaufen lassen — siehe unten.
- **Ebenen**: jede Kartenebene lässt sich aus dem Menü „Ebenen" nehmen. Wer
  Amateurfunk oder Erdbeben nie braucht, blendet sie aus; die Ebene wird dabei
  ausgeschaltet. Jede Zeile nennt gleich mit, woher ihre Daten kommen. Die
  Auswahl liegt im localStorage und überlebt den Neustart. Ebenen, für die dem
  Server der Zugang fehlt (Schiffe ohne `AISSTREAM_KEY`, Verkehrsfluss ohne
  `TOMTOM_KEY`, Amateurfunk ohne `APRSFI_KEY`, Blitze ohne Empfang), stehen
  **ausgegraut** in der Liste samt Grund — auf der Karte tauchen sie weiterhin
  gar nicht erst auf.
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

### Diashow für den großen Monitor

Eine **Karte** ist eine gespeicherte Zusammenstellung von Ebenen. Zwei Wege
führen dorthin: **„Neue Karte zusammenstellen"** öffnet gleich die
Ebenenauswahl im Menü (alle Ebenen nach Gruppen, einzeln an- und abschaltbar),
**„Aktuelle Ansicht sichern"** übernimmt, was gerade auf der Karte liegt. Die
Auswahl einer bestehenden Karte lässt sich jederzeit über ihre Ebenenzeile
wieder aufklappen und ändern.

Karten lassen sich umbenennen, per **Ziehen am Griff (⠿)** sortieren — ↑/↓
bleiben für die Bedienung ohne Maus —, mit einer **Standzeit** versehen (10 s
bis 2 min) und einzeln zur Kontrolle auf die Karte legen.

„Diashow starten" schaltet dann selbsttätig weiter. Dabei blendet die App auf
Wunsch alles außer der Karte aus (Kopfzeile und Kachelspalte verschwinden) —
gedacht für einen Monitor, der ohne Zutun durchläuft. Die Leiste oben zeigt
Position, Name und einen Fortschrittsbalken der Standzeit und lässt sich
bedienen: ‹ › blättern, ❚❚ hält an, ✕ beendet. Per Tastatur: **Pfeiltasten**
blättern, **Leertaste** hält an, **Esc** beendet — Esc schließt allerdings
zuerst offene Menüs, deshalb hängt der Lauscher in der Erfassungsphase.

Karten und Ablauf liegen im localStorage (`mapPresets.ts`) und überleben den
Neustart.

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
* **Ausgabe als GPX**: Der Knopf „GPX" unter der Route schreibt eine Datei mit
  **allen drei Sichten** — `<trk>` mit dem vollständigen Linienzug (dem folgt
  jedes Wander- und Radgerät), `<rte>` mit einem Punkt je Fahranweisung samt
  Text, und `<wpt>` für Start, Zwischenziele und Ziel. Liegt ein Höhenprofil
  vor, stehen die Höhen mit in den Trackpunkten;
* **Bildschirm bleibt an**, solange geführt wird (Screen Wake Lock) — sonst
  geht das Telefon am Lenker nach einer halben Minute aus, und mit ihm die
  Ansage. Beim Wechsel in den Hintergrund gibt das System die Sperre frei; kommt
  die App zurück, fordert sie sie neu an;
* **Zielführung** mit Positionsverfolgung, mitdrehender Karte, Restweg/Ankunft,
  Sprachansagen (SpeechSynthesis des Geräts, abschaltbar) und automatischer
  Neuberechnung, wenn man von der Route abkommt.

### Zwischenziele

Die Route kennt neben Start und Ziel beliebig viele **Zwischenziele**. Gesetzt
werden sie über den Knopf **„+ Zwischenziel"** in der Routenleiste (der nächste
Tipper auf die Karte legt es fest) oder über das Punktmenü auf der Karte
(langes Antippen → „Als Zwischenziel"). In der Zielliste lassen sie sich
**verschieben und entfernen**; die Karte nummeriert sie mit, und unter der
Zusammenfassung steht jeder Abschnitt einzeln mit Länge und Fahrzeit.

Gerechnet wird abschnittsweise: A* sucht immer den kürzesten Weg zwischen zwei
Punkten, also ist die **Reihenfolge eine Vorgabe des Nutzers**, keine
Optimierungsaufgabe (kein Handlungsreisenden-Problem). Wer eine andere
Reihenfolge will, sortiert die Liste um — „Start und Ziel tauschen" dreht auch
die Zwischenziele um. Streckenvarianten gibt es mit Zwischenzielen nicht: sie
entstehen aus Aufschlägen auf benutzte Kanten, und über mehrere Abschnitte
hinweg käme dabei nur Willkür heraus.

**Ausweichkanten beim Fangen** (dabei entstanden, betrifft aber jeden Punkt):
Ein Tipper auf die Karte landet gern auf einer Parkplatzgasse oder einem für
Autos gesperrten Parkweg — von dort führt kein Weg weg, und die Suche meldete
„keine Verbindung". Das Fangen liefert deshalb jetzt **mehrere Kanten** (bis
250 m hinter der nächsten), und vorab prüft ein paar Dutzend Schritte weite
Suche, ob von einer Kante überhaupt etwas erreichbar ist. Ohne diese Vorprüfung
merkt A* das erst, nachdem es das ganze übrige Netz abgesucht hat — gemessen
1,7 s statt 46 ms.

Geprüft mit `scripts/check-via.mts` (Naht ohne Doppelpunkt, verschobene
Anweisungsindizes, Summen der Abschnitte, Reihenfolge, Stichweg-Fall).

### Höhenprofil

Unter der Zusammenfassung steht das **Höhenprofil**: Anstieg, Abstieg, Spanne
und die Kurve über die Strecke; der Zeiger darüber liest Entfernung und Höhe
ab. Für Rad und zu Fuß entscheidet das oft mehr als die Länge.

Die Höhen kommen **offline aus einem eigenen Paket** `<code>.terrain`, das
neben Karte, Routing und Suche steht und einzeln abwählbar ist (Bremen 0,2 MB,
Hessen 3,9 MB). Gebaut wird es aus den freien **Terrain Tiles** des
AWS-Open-Data-Programms (`elevation-tiles-prod`, „terrarium"-PNG: Höhe =
R·256 + G + B/256 − 32768; Daten u. a. SRTM/3DEP):

```bash
node scripts/build-terrain.mjs --out apps/api/maps --zoom 10 04 06
```

Gespeichert wird das Raster **im Kachelgitter der Quelle** (Web Mercator, Zoom
10 ≈ 96 m je Punkt) als Int16 mit zeilenweisen Differenzen — Nachbarpunkte
unterscheiden sich um wenige Meter, dadurch packt der Container das Raster um
ein Vielfaches besser. Der PNG-Leser (`scripts/lib/png.mjs`) ist wie der Rest
selbst geschrieben.

Bringt eine **eingelesene GPX-Datei eigene Höhen** mit, haben die Vorrang — sie
wurden am Gerät gemessen. Beim Aufsummieren der Höhenmeter zählen nur Anstiege
über 4 m: sonst summiert sich das Rauschen des Rasters zu Fantasiewerten, und
eine flache Fahrt durch Bremen käme auf dreistellige Höhenmeter.

Geprüft mit `scripts/check-terrain.mts` gegen bekannte Höhen (Bremer
Marschland, Nordsee, Großer Feldberg 848 m, Wasserkuppe 930 m).

**Während der Zielführung** zeigt die Navigationsleiste bei **Rad und zu Fuß**
das Profil in schmaler Form mit der aktuellen Stelle und dem **Restanstieg** —
am Berg sagt die Gesamtsumme nichts mehr. Beim Auto bleibt es weg.

Das Höhenpaket speist außerdem die Kartenebene **„Gelände"**: Höhenfarben mit
Schummerung (Licht von Nordwesten, 45° hoch — so liest das Auge die Form richtig
herum). Das Raster liegt bereits in Web Mercator, also genau in der Projektion,
in der MapLibre eine `image`-Quelle aufspannt; anders als bei den Gittern in
Länge/Breite braucht es keine Umrechnung je Bildzeile. Gerechnet wird das Bild
im Worker, gemalt im Hauptfaden. Bei `--zoom 11` wird das Raster doppelt so fein
(≈48 m) und die Datei rund viermal so groß.

### Einer GPX-Tour folgen

In der Routenleiste liest **„GPX-Tour"** eine Datei ein (genommen wird die
längste Linie darin — Tourenportale legen gern Anfahrtsschnipsel dazu). Danach
steht die Wahl zwischen zwei Arten, ihr zu folgen:

- **Genau dieser Linie folgen.** Die Tour *ist* die Route: `routeFromLine()`
  baut sie ohne Graphen, die Anweisungen entstehen allein aus den
  Richtungswechseln („in 200 m rechts abbiegen"), also ohne Straßennamen.
  Funktioniert abseits von Straßen und ohne gespeicherte Region. Die Fahrzeit
  ist ein ehrlicher Mittelwert je Fortbewegungsart — ohne Straßendaten ist mehr
  nicht zu holen. Ein Profilwechsel rechnet nur die Zeit neu, die Linie bleibt.
  Weicht man ab, wird **nicht** neu berechnet: es gibt nichts zu rechnen, der
  Weg zurück auf die Spur bleibt Sache des Fahrers.
- **Auf dem Straßennetz nachrechnen.** Die Stützpunkte werden zu Zwischenzielen
  (`viaPointsFromLine()`, gleichmäßig verteilt, höchstens 18 — mehr macht die
  Rechnung langsam und zwingt den Router auf jeden Messfehler), der Rest ist die
  normale Routenplanung mit echten Abbiegehinweisen.

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

## Wander- und Radwegenetz

Die Ebene **„Wander- und Radwege"** zeigt die ausgeschilderten Routen: Rad blau,
Wandern grün, gestrichelt, ab Zoom 10; ab Zoom 12 steht der Name der Route an
der Linie (`E1`, `EV3 EuroVelo 3`, `Weserradweg`).

Die Daten liegen **nicht doppelt im Gerät**: Beim Paketbau werden die
OSM-Relationen `type=route` mit `route=hiking|foot|walking|bicycle|mtb`
ausgewertet und ihre Mitgliedswege als **Bitmaske an den Kanten** des
Routing-Graphen vermerkt (ein Byte je Kante, dazu der Routenname). Gezeichnet
wird aus derselben Geometrie, auf der auch das Routing läuft.

Zwei Feinheiten:

- Die Relationen stehen in der PBF **hinter** den Wegen. Nachgeschlagen wird
  deshalb erst am Ende und nur für die Wege, die tatsächlich im Graphen gelandet
  sind — eine Tabelle über alle Wege des Landes wäre unnötig groß.
- Liegen mehrere Routen auf derselben Kante, gibt die **überregionalere** den
  Namen (`network=iwn/icn` vor `nwn/ncn` vor `rwn/rcn` vor `lwn/lcn`). Sonst
  gewönne eine beliebige Ortsrunde gegen den Europäischen Fernwanderweg.

Bremen: 353 Routen, 15.774 Kanten (13 %), 57 verschiedene Namen — das Paket
wuchs dadurch von 1,85 auf 1,90 MB. **Ältere Pakete kennen das Netz noch
nicht**; die Ebene sagt das dann und bleibt leer, bis die Region neu geladen
ist.

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

In der Kachel **Bahn / ÖPNV** und in ihrer Detailliste führt „Navigieren" jede
Haltestelle direkt in die Routenplanung.

Auch aus einer **Abfahrt** heraus lässt sich der ganze Weg dieser Fahrt auf die
Karte legen: „Fahrtweg auf der Karte" zeichnet ihn wie beim angetippten
Fahrzeug, nur ohne den „schon gefahren"-Teil — den gibt es erst, wenn eine
Position bekannt ist. Das Band oben links nimmt ihn wieder weg.

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

## Behördenwarnungen (BBK / NINA)

Die Ebene **„Warnungen"** heißt jetzt **„Unwetterwarnungen"** und steht bei den
Wetterebenen — sie zeigt weiterhin nur den DWD. Alles andere, was über das
Warnsystem des Bundes läuft, liegt in der neuen Ebene **„Behördenwarnungen"**
(Gruppe Gefahren):

| Kanal | Inhalt |
| --- | --- |
| MoWaS | Warnungen von Behörden: Gefahrstoffe, Trinkwasser, Bombenfund, Evakuierung |
| KATWARN, BIWAPP | kommunale Warnsysteme |
| Polizei | polizeiliche Gefahrenmeldungen |
| LHP | Länderübergreifendes Hochwasserportal |

`/api/nina` fragt `warnung.bund.de/api31` ab — frei und ohne Schlüssel, aber
**zweistufig**: Die Übersicht je Kanal (`<kanal>/mapData.json`) nennt nur
Kennung, Titel und Stufe; Text und Fläche kommen einzeln aus
`warnings/<id>.json` und `warnings/<id>.geojson`. Deshalb wird die Übersicht
kurz (60 s) und die Einzelmeldung lange (15 min, Schlüssel samt Versionszähler)
gecacht, und pro Abruf werden höchstens 80 Meldungen aufgelöst. Zurückgezogene
Meldungen (`Cancel`) fliegen raus, CAP-Texte werden von HTML befreit.

Auf der Karte: Fläche in der Farbe der Warnstufe mit **gestricheltem** Rand
(unterscheidbar, wenn sie über einer DWD-Warnfläche liegt) und ein Warndreieck
in der Mitte — kleine Gebiete sind sonst kaum zu treffen. Das Popup nennt Stufe,
Kanal, Gebiet, Gültigkeit, Beschreibung, Handlungsanweisung und verlinkt die
Behörde; die Kachel „Im Ausschnitt" zählt sie unter **Behörden** und öffnet die
Liste.

## Feuer aus dem Satellitenblick (NASA FIRMS)

Die Waldbrandgefahr sagt, wie leicht es brennen *könnte* — die Ebene **„Feuer
(Satellit)"** zeigt, wo es tatsächlich heiß ist. Quelle sind die
VIIRS-Instrumente auf Suomi-NPP und NOAA-20; NASA veröffentlicht die
Detektionen der letzten 24 Stunden je Kontinent als **offene CSV ohne
Schlüssel** (das schlüsselpflichtige API braucht es dafür nicht). Kreisgröße und
Farbe folgen der Strahlungsleistung (FRP in Megawatt).

**Der Vorbehalt gehört dazu und steht im Popup:** Eine Detektion ist ein heißer
Bildpunkt von etwa 375 m Kantenlänge, kein bestätigter Brand — Industrie,
Fackeln oder Feldarbeit sehen für den Satelliten genauso aus.

## Strahlung: Ortsdosisleistung (BfS)

Rund 1700 Sonden des Bundesamts für Strahlenschutz melden stündlich die
Gamma-Ortsdosisleistung; `imis.bfs.de` gibt sie als offenen WFS heraus. Die
Ebene **„Strahlung (ODL)"** zeichnet sie als Punkte, deren Farbe erst über dem
natürlichen Untergrund warm wird.

Zur Einordnung: In Deutschland liegt der Untergrund je nach Geologie und Höhe
etwa zwischen 0,05 und 0,18 µSv/h. Auffällig ist deshalb nicht ein hoher
Absolutwert, sondern ein Wert deutlich über dem, was diese Sonde sonst zeigt —
das Popup nennt den Messwert, eine Einordnung im Klartext („im normalen
Bereich", „leicht erhöht", „deutlich erhöht") und den natürlichen Anteil aus
kosmischer und terrestrischer Strahlung.

Genau deshalb steht darunter der **Verlauf der letzten drei Tage** als Kurve,
wie beim Pegel: erst er zeigt, ob ein Wert zur Sonde passt.
`/api/radiation/history?id=…` liest dafür die Stundenwerte aus der WFS-Ebene
`odlinfo_timeseries_odl_1h` (Filter über die Sondenkennung, absteigend sortiert)
und wird beim Öffnen des Popups nachgeladen. Zwei Feinheiten: Nachgereichte
Einzelwerte hängen sonst als weit zurückliegender Punkt an der Kurve — die
Route beschneidet deshalb hart auf das Zeitfenster; und die Kurve hat eine
**Mindestspanne von 0,02 µSv/h**, damit das Rauschen einer ruhigen Sonde nicht
wie ein dramatischer Ausschlag aussieht. Ein echter Regenwaschausschlag (0,074
auf 0,132 µSv/h) bleibt dabei deutlich sichtbar.

## Pollenflug (DWD)

Im Wetterblatt steht unten der **Pollenflug-Gefahrenindex** des DWD: acht Arten
(Hasel bis Ambrosia) für heute, morgen und übermorgen, als Balken mit Text.
Arten ohne Belastung stehen zusammengefasst in einer Zeile darunter.

Der DWD gibt den Index **je Region** heraus, nicht je Ort — und die Regionen
kommen ohne Geometrie. `/api/pollen` ordnet deshalb über das Bundesland zu; hat
eine Region mehrere Teilregionen, gewinnt der **höhere** Wert (im Zweifel lieber
eine Warnung zu viel). Beides steht unter der Tabelle, damit niemand die Zahl
für punktgenau hält. Erneuert wird einmal täglich gegen 11 Uhr.

## Rastplätze, Ladepunkte und Webcams

Die Ebene **„Rastplätze & Laden"** (Gruppe Verkehr, ab Zoom 8) nutzt zwei
weitere Endpunkte derselben Autobahn-Schnittstelle, aus der schon die
Verkehrsmeldungen kommen: `parking_lorry` (Rastanlagen mit Pkw- und
Lkw-Stellplätzen) und `electric_charging_station` (Ladepunkte samt Leistung und
Betreiber, auch das Deutschlandnetz). Beides ändert sich in Wochen, nicht in
Minuten — `/api/rest` baut die Liste deshalb einmal über alle rund 120
Autobahnen auf und hält sie sechs Stunden.

**Falle bei der Benennung:** Die beiden Endpunkte beschriften ihre Anlagen
unterschiedlich. Bei Rastanlagen steht der Name im **Untertitel** („NI 40 W bei
km 197,8"), während der Titel nur die Autobahn mit ihren beiden Enden nennt
(„A1 | Puttgarden") — als Überschrift wäre das grob irreführend. Ladepunkte
hängen den Namen dagegen hinten an den Titel und schreiben die Art in den
Untertitel. Die Route dreht das gerade.

Die Ebene **„Webcams"** (Gruppe Wetter) zeigt die Standorte der
Panorama-Kameras von [Foto-Webcam.eu](https://www.foto-webcam.eu/) — rund 370
Stück, davon gut hundert in Deutschland, der Rest im Alpenraum. Das Popup nennt
Höhe und Blickrichtung (als Himmelsrichtung, nicht nur in Grad) und verlinkt
die Kameraseite.

**Bitte des Betreibers (eingehalten):** Das Impressum erlaubt Links auf die
Seite und ihre Unterseiten ausdrücklich, die Nutzung der **Bilder** ist aber je
Kamera geregelt. Deshalb zeigt die App **kein einziges Kamerabild**, sondern
Standort, Blickrichtung und Link — dorthin, wo die Betreiber ihre eigenen
Bedingungen nennen. Eine Datenschnittstelle gibt es nicht; die Liste steht als
JSON im Quelltext der Übersichtsseite und wird alle sechs Stunden **einmal für
alle Nutzer** gelesen.

## Blitze (Blitzortung.org)

Die Ebene **„Blitze"** (Gruppe Gefahren) zeigt die Entladungen der letzten
30 Minuten: ein heller Kern mit weichem Schein, der mit dem Alter kleiner und
blasser wird (frisch = weiß-gelb und groß, 30 min = klein und dunkel). Das
Popup nennt Zeitpunkt, Zahl der Empfangsstationen und die gemeldete
Ortungsgenauigkeit; die Kachel „Im Ausschnitt" zählt sie mit.

Quelle ist das ehrenamtliche Empfängernetz von
[Blitzortung.org](https://www.blitzortung.org/), dessen Live-Karte ihre Daten
über einen WebSocket bezieht — genau den nutzt `/api/lightning`. Die Nachrichten
sind wörterbuchkomprimiert (LZW-Abkömmling) und werden serverseitig
entpackt.

**Bitten des Betreibers (eingehalten):** Die Daten stammen von Freiwilligen und
sind für private, nicht gewerbliche Nutzung gedacht, Quellenangabe erwünscht.
Deshalb hält der Server **eine einzige** Verbindung für alle Besucher (nicht
eine je Browser), baut sie mit wachsendem Abstand wieder auf, hält die Treffer
nur 30 Minuten im Arbeitsspeicher (keine Archivierung) und nennt die Quelle in
Popup, Ebenen-Menü und Quellenliste. Ohne eingehende Blitze erscheint die Ebene
gar nicht erst im Menü (`features.lightning` in `/api/health`).

## Rettungspunkte

Die Ebene **„Rettungspunkte"** (Gruppe Lage, ab Zoom 11) zeigt die
nummerierten Schilder im Wald, an Wegen und in Naherholungsgebieten — die
Kennung darauf gibt man dem Rettungsdienst durch, wenn man den eigenen Standort
nicht benennen kann. Das Popup nennt sie groß, dazu die Koordinaten in
Dezimalgrad **und** in Grad/Minuten, wie Leitstellen sie erwarten.

Quelle ist OpenStreetMap (`highway=emergency_access_point`) über die
**Overpass-API**: rund **47.000** Punkte in Deutschland, die Kennung steht im
`ref`. Die forstlichen GPX-Sammlungen der Länder enthalten dieselben Punkte,
sind aber je Bundesland anders lizenziert und ohne einheitliche Schnittstelle;
OSM steht unter der ODbL und ist hier ohnehin die Kartengrundlage.

**Rücksicht auf Overpass** (ein gespendeter Dienst): abgefragt wird nur der
Kartenausschnitt, auf ein 0,25°-Raster aufgerundet, damit benachbarte
Ausschnitte denselben Cache treffen; höchstens 1,5° Spanne, Ergebnis zwölf
Stunden gültig. Die Punkte ändern sich in Jahren.

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

## App-Symbol und Installierbarkeit

Die PWA lässt sich installieren (Android/Chrome, iOS „Zum Home-Bildschirm",
Desktop): Manifest mit Name, `start_url`, `display: standalone` und Symbolen in
192 und 512 Pixeln, dazu **maskierbare** Fassungen für Android (dort schneidet
das System Kreise oder Tropfen aus, deshalb liegt in der Vorlage
`icon-maskable.svg` nichts Wesentliches am Rand) und ein `apple-touch-icon`
für iOS.

Vorlagen sind `apps/web/public/icons/icon.svg` und `icon-maskable.svg` — das
Schild mit Haken aus der Kopfzeile. Die PNG-Größen liegen fertig im
Repository; wer das Symbol ändert, erzeugt sie neu mit

```bash
node scripts/build-icons.mjs
```

Gerastert wird mit dem Chromium, den Playwright ohnehin mitbringt — keine
Bildbibliothek als Abhängigkeit. Für den reinen Bau der App wird das Skript
nicht gebraucht.

## Deployment

Läuft hinter einem eigenen Reverse-Proxy (TLS dort terminieren). Installation und
Update erfolgen mit **einem Befehl** aus diesem Repo (siehe `install.sh`, folgt).
Der Hono-Server liefert im Prod-Betrieb sowohl die API als auch das gebaute
PWA-Bundle aus.

## Lizenz

MIT
