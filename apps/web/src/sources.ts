/**
 * Woher die Daten kommen und worauf sie fußen.
 *
 * Die Liste steht bewusst im Frontend und nicht im README: Wer die App
 * benutzt, soll ohne Umweg sehen können, wessen Daten er da vor sich hat —
 * mehrere Anbieter bitten ausdrücklich um Nennung und Rücklink.
 */

export interface SourceInfo {
  key: string;
  name: string;
  /** Wofür in dieser App. */
  use: string;
  url: string;
  /** Lizenz, Bedingungen oder eingehaltene Bitte des Anbieters. */
  terms?: string;
}

/** Datenquellen, gruppiert nach Thema. */
export const SOURCE_GROUPS: { group: string; items: SourceInfo[] }[] = [
  {
    group: 'Wetter und Gefahren',
    items: [
      {
        key: 'brightsky',
        name: 'Bright Sky (DWD)',
        use: 'Wetter, Vorhersage und Regenradar (RADOLAN-RV)',
        url: 'https://brightsky.dev/',
        terms: 'DWD-Daten, Bright Sky vermittelt sie frei und ohne Schlüssel',
      },
      {
        key: 'dwd-geo',
        name: 'DWD-GeoServer',
        use: 'amtliche Unwetterwarnungen als Gemeindeflächen',
        url: 'https://maps.dwd.de/geoserver/',
        terms: 'Deutscher Wetterdienst, Nutzung mit Quellenangabe',
      },
      {
        key: 'dwd-open',
        name: 'DWD Open Data',
        use: 'Waldbrandgefahrenindex je Messstation',
        url: 'https://opendata.dwd.de/',
        terms: 'GeoNutzV, Quellenangabe „Deutscher Wetterdienst"',
      },
      {
        key: 'openmeteo',
        name: 'Open-Meteo',
        use: 'Windfeld und Luftqualität',
        url: 'https://open-meteo.com/',
        terms: 'CC BY 4.0, frei ohne Schlüssel',
      },
      {
        key: 'rainviewer',
        name: 'RainViewer',
        use: 'Regenradar-Kacheln als Rückfall außerhalb der DWD-Abdeckung',
        url: 'https://www.rainviewer.com/api.html',
      },
      {
        key: 'usgs',
        name: 'USGS Earthquake Hazards Program',
        use: 'Erdbeben der letzten Woche',
        url: 'https://earthquake.usgs.gov/',
        terms: 'gemeinfrei (US-Behörde)',
      },
    ],
  },
  {
    group: 'Verkehr und Wege',
    items: [
      {
        key: 'autobahn',
        name: 'Autobahn GmbH des Bundes',
        use: 'Baustellen, Sperrungen, Staumeldungen',
        url: 'https://autobahn.api.bund.dev/',
        terms: 'offene Verwaltungsdaten (bund.dev)',
      },
      {
        key: 'transitous',
        name: 'transitous.org (MOTIS)',
        use: 'Haltestellen, Abfahrten, Verbindungen, fahrende Busse und Bahnen',
        url: 'https://transitous.org/',
        terms: 'gemeinschaftlich betrieben, frei ohne Schlüssel — sparsam abfragen',
      },
      {
        key: 'adsb',
        name: 'adsb.fi / adsb.lol',
        use: 'Flugzeugpositionen (ADS-B)',
        url: 'https://adsb.fi/',
        terms: 'offenes Empfängernetz, Daten der Beitragenden',
      },
      {
        key: 'adsbdb',
        name: 'adsbdb.com',
        use: 'Halter, Muster und Flugroute beim Antippen eines Flugzeugs',
        url: 'https://www.adsbdb.com/',
      },
      {
        key: 'aisstream',
        name: 'aisstream.io',
        use: 'Schiffspositionen (AIS)',
        url: 'https://aisstream.io/',
        terms: 'eigener Schlüssel nötig (kostenlos nach Registrierung)',
      },
      {
        key: 'tomtom',
        name: 'TomTom Traffic',
        use: 'Verkehrsfluss-Kacheln',
        url: 'https://developer.tomtom.com/',
        terms: 'eigener Schlüssel nötig, Anzeige nur mit gültigem Schlüssel',
      },
      {
        key: 'photon',
        name: 'Photon (Komoot)',
        use: 'Ortssuche, wenn eine Verbindung besteht',
        url: 'https://photon.komoot.io/',
        terms: 'auf OpenStreetMap-Daten, Ergebnisse werden 7 Tage gecacht',
      },
    ],
  },
  {
    group: 'Wasser, Funk und Nachrichten',
    items: [
      {
        key: 'pegelonline',
        name: 'PEGELONLINE (WSV)',
        use: 'Wasserstände und ihr Verlauf',
        url: 'https://www.pegelonline.wsv.de/',
        terms: 'Wasserstraßen- und Schifffahrtsverwaltung des Bundes, frei nutzbar',
      },
      {
        key: 'tagesschau',
        name: 'tagesschau.de',
        use: 'bundesweite und regionale Nachrichten',
        url: 'https://tagesschau.api.bund.dev/',
        terms: 'offene Schnittstelle (bund.dev)',
      },
      {
        key: 'hamqsl',
        name: 'N0NBH (hamqsl.com)',
        use: 'Funkwetter-Kennzahlen und Bandbewertungen',
        url: 'https://www.hamqsl.com/solar.html',
        terms: 'stündlich erneuert — hier eine Stunde gecacht, Quelle genannt',
      },
      {
        key: 'kc2g',
        name: 'prop.kc2g.com (GIRO)',
        use: 'Ionosonden-Messwerte für die MUF-Ebene',
        url: 'https://prop.kc2g.com/',
        terms: 'alle 15 Minuten erneuert — hier ebenso lange gecacht, Quelle genannt',
      },
      {
        key: 'noaa',
        name: 'NOAA Space Weather Prediction Center',
        use: 'Polarlicht-Wahrscheinlichkeit (OVATION), Kp-Index, Sonnenfluss',
        url: 'https://www.swpc.noaa.gov/',
        terms: 'gemeinfrei (US-Behörde)',
      },
      {
        key: 'aprsfi',
        name: 'aprs.fi',
        use: 'Positionen beobachteter Amateurfunk-Rufzeichen',
        url: 'https://aprs.fi/',
        terms: 'eigener Schlüssel je Nutzer, Nennung mit Rücklink, Abruf nur auf Wunsch',
      },
    ],
  },
  {
    group: 'Karte und Offline-Daten',
    items: [
      {
        key: 'osm',
        name: 'OpenStreetMap',
        use: 'Grundlage der Karte, der Offline-Suche, des Routings und der Notfallpunkte',
        url: 'https://www.openstreetmap.org/copyright',
        terms: '© OpenStreetMap-Mitwirkende, ODbL',
      },
      {
        key: 'geofabrik',
        name: 'Geofabrik',
        use: 'Länderauszüge (PBF), aus denen Routing und Suche gebaut werden',
        url: 'https://download.geofabrik.de/',
        terms: 'Auszüge aus OpenStreetMap, ODbL',
      },
      {
        key: 'protomaps',
        name: 'Protomaps',
        use: 'Kartenstil und Vektorkacheln (PMTiles) für online wie offline',
        url: 'https://protomaps.com/',
        terms: 'quelloffener Stil, Kacheln aus OpenStreetMap',
      },
    ],
  },
];

/** Freie Software, auf der die App aufsetzt. */
export const PROJECTS: { name: string; use: string; url: string }[] = [
  { name: 'MapLibre GL JS', use: 'Kartendarstellung', url: 'https://maplibre.org/' },
  { name: 'PMTiles', use: 'Kartenkacheln in einer einzigen Datei — Grundlage der Offline-Karte', url: 'https://protomaps.com/docs/pmtiles' },
  { name: 'React', use: 'Oberfläche', url: 'https://react.dev/' },
  { name: 'Vite', use: 'Bau und Entwicklung', url: 'https://vite.dev/' },
  { name: 'vite-plugin-pwa / Workbox', use: 'Installierbarkeit und Offline-Betrieb', url: 'https://vite-pwa-org.netlify.app/' },
  { name: 'Hono', use: 'schlanker Server, der die Quellen bündelt', url: 'https://hono.dev/' },
  { name: 'Dexie', use: 'letzter Datenstand im Browser', url: 'https://dexie.org/' },
  { name: 'MOTIS', use: 'Fahrplanauskunft hinter transitous.org', url: 'https://github.com/motis-project/motis' },
];

/** Nachschlagen für die Ebenen-Liste. */
export const SOURCE_BY_KEY: Record<string, SourceInfo> = Object.fromEntries(
  SOURCE_GROUPS.flatMap((g) => g.items).map((s) => [s.key, s]),
);
