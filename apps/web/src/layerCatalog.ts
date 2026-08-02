/**
 * Verzeichnis aller Kartenebenen.
 *
 * Eine Liste, zwei Verwender: das Ebenen-Menü auf der Karte baut daraus seine
 * Zeilen, die Einstellungen ihre Auswahl „brauche ich nicht". Deshalb steht
 * hier alles Feste (Name, Farbe, Gruppe, Erklärung) — nur der Schaltzustand und
 * das, was von Schlüsseln oder geladenen Regionen abhängt, kommt zur Laufzeit
 * dazu.
 */

export type LayerId =
  | 'warnings'
  | 'radar'
  | 'flow'
  | 'traffic'
  | 'pegel'
  | 'aircraft'
  | 'vessels'
  | 'aprs'
  | 'wind'
  | 'night'
  | 'stops'
  | 'muf'
  | 'news'
  | 'vehicles'
  | 'emergency'
  | 'quakes'
  | 'aurora'
  | 'fire';

/** Zusätzlich zu den Ebenen: eingerückte Anzeigeoptionen. */
export type LayerRowId = LayerId | 'wind-labels';

export interface LayerInfo {
  id: LayerRowId;
  label: string;
  /** Farbtupfer bzw. Verlauf, damit die Ebene wiedererkennbar ist. */
  color: string;
  group: string;
  hint?: string;
  /** Eingerückte Unteroption der Ebene darüber. */
  sub?: boolean;
  /** Nur sichtbar, wenn der Server diese Möglichkeit meldet. */
  needs?: 'flow' | 'ais' | 'aprs';
  /** Woher die Daten kommen — als Schlüssel in `SOURCES`. */
  source?: string;
}

/** Reihenfolge = Reihenfolge im Menü; die Gruppen ergeben sich daraus. */
export const LAYER_CATALOG: LayerInfo[] = [
  { id: 'emergency', label: 'Notfallpunkte', color: '#a92318', group: 'Lage', hint: 'Klinik, Apotheke, Polizei, Feuerwehr — offline', source: 'osm' },
  { id: 'quakes', label: 'Erdbeben', color: '#8a4b1d', group: 'Lage', hint: 'letzte Woche, ab Stärke 2,5', source: 'usgs' },
  { id: 'news', label: 'Nachrichten', color: '#6a7580', group: 'Lage', hint: 'regionale Meldungen mit Ortsbezug', source: 'tagesschau' },
  { id: 'warnings', label: 'Warnungen', color: '#a92318', group: 'Gefahren', hint: 'amtliche Unwetterwarnungen', source: 'dwd-geo' },
  { id: 'fire', label: 'Waldbrandgefahr', color: 'linear-gradient(90deg,#3f8f4a,#e3b505,#a92318)', group: 'Gefahren', hint: 'DWD-Index, Stufe 1–5', source: 'dwd-open' },
  { id: 'radar', label: 'Regenradar', color: '#3f83d4', group: 'Wetter', hint: 'Messung und Vorhersage bis +2 h', source: 'brightsky' },
  { id: 'wind', label: 'Wind', color: '#2c7448', group: 'Wetter', hint: 'Strömungsbild, 10 m über Grund', source: 'openmeteo' },
  { id: 'wind-labels', label: 'Windwerte', color: '#2c7448', group: 'Wetter', hint: 'km/h an den Gitterpunkten', sub: true },
  { id: 'night', label: 'Tag/Nacht', color: '#0b1a33', group: 'Wetter', hint: 'Dämmerungsgrenze, selbst gerechnet' },
  { id: 'flow', label: 'Verkehrsfluss', color: 'linear-gradient(90deg,#2c9e5b,#e0a90b,#c0392b)', group: 'Verkehr', needs: 'flow', source: 'tomtom' },
  { id: 'traffic', label: 'Verkehrsmeldungen', color: 'var(--sev3)', group: 'Verkehr', hint: 'Baustellen, Sperrungen, Staus', source: 'autobahn' },
  { id: 'vehicles', label: 'Busse & Bahnen', color: '#a92318', group: 'Verkehr', hint: 'Position aus dem Fahrplan gerechnet', source: 'transitous' },
  { id: 'stops', label: 'Haltestellen', color: '#1d4e73', group: 'Verkehr', hint: 'Bus, Tram, Bahn · ab Zoom 12', source: 'transitous' },
  { id: 'aircraft', label: 'Flugzeuge', color: '#1d4e73', group: 'Verkehr', hint: 'ADS-B, ab Zoom 6', source: 'adsb' },
  { id: 'vessels', label: 'Schiffe', color: '#2c7448', group: 'Verkehr', hint: 'AIS', needs: 'ais', source: 'aisstream' },
  { id: 'aprs', label: 'Amateurfunk', color: '#6b3fa0', group: 'Verkehr', hint: 'feste Rufzeichenliste', needs: 'aprs', source: 'aprsfi' },
  { id: 'pegel', label: 'Pegel', color: 'var(--accent)', group: 'Wasser', hint: 'Wasserstände mit Verlauf', source: 'pegelonline' },
  { id: 'muf', label: 'Ausbreitung (MUF)', color: 'linear-gradient(90deg,#3b4a7a,#2c8f6a,#d0a71a,#a4218c)', group: 'Funk', hint: 'Kurzwelle: höchste brauchbare Frequenz', source: 'kc2g' },
  { id: 'aurora', label: 'Polarlicht', color: '#3cba7a', group: 'Funk', hint: 'Wahrscheinlichkeit (NOAA)', source: 'noaa' },
];

/** Ebenen, die man nicht ausblenden können soll — sonst fehlt die Grundlage. */
export const ALWAYS_SHOWN: LayerRowId[] = ['wind-labels'];
