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
  | 'blaulicht'
  | 'bosair'
  | 'vehicles'
  | 'emergency'
  | 'quakes'
  | 'aurora'
  | 'fire'
  | 'lightning'
  | 'nina'
  | 'fires'
  | 'radiation'
  | 'rest'
  | 'webcams'
  | 'rescue'
  | 'draw'
  | 'terrain'
  | 'trails'
  | 'contours'
  | 'avalanche';

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
  /** Nur nutzbar, wenn der Server diese Möglichkeit meldet. */
  needs?: 'flow' | 'ais' | 'aprs' | 'lightning';
  /** Woher die Daten kommen — als Schlüssel in `SOURCES`. */
  source?: string;
}

/**
 * Reihenfolge = Reihenfolge im Menü; auch die Gruppen ergeben sich daraus
 * (Wetter, Gefahren, Verkehr, Lage, Funk — vom Alltäglichen zum Besonderen).
 */
export const LAYER_CATALOG: LayerInfo[] = [
  // Wetter
  { id: 'warnings', label: 'Unwetterwarnungen', color: '#a92318', group: 'Wetter', hint: 'amtlich vom DWD', source: 'dwd-geo' },
  { id: 'radar', label: 'Regenradar', color: '#3f83d4', group: 'Wetter', hint: 'Messung und Vorhersage bis +2 h', source: 'brightsky' },
  { id: 'lightning', label: 'Blitze', color: '#e3b505', group: 'Wetter', hint: 'Entladungen der letzten 30 Minuten', needs: 'lightning', source: 'blitzortung' },
  { id: 'wind', label: 'Wind', color: '#2c7448', group: 'Wetter', hint: 'Strömungsbild, 10 m über Grund', source: 'openmeteo' },
  { id: 'wind-labels', label: 'Windwerte', color: '#2c7448', group: 'Wetter', hint: 'km/h an den Gitterpunkten', sub: true },
  { id: 'webcams', label: 'Webcams', color: '#5b5b60', group: 'Wetter', hint: 'Panorama-Kameras · Bild auf der Betreiberseite', source: 'fotowebcam' },
  { id: 'night', label: 'Tag/Nacht', color: '#0b1a33', group: 'Wetter', hint: 'Dämmerungsgrenze, selbst gerechnet' },

  // Gefahren
  { id: 'nina', label: 'Behördenwarnungen', color: '#6c2790', group: 'Gefahren', hint: 'MoWaS, KATWARN, BIWAPP, Polizei, Hochwasser', source: 'nina' },
  { id: 'fire', label: 'Waldbrandgefahr', color: 'linear-gradient(90deg,#3f8f4a,#e3b505,#a92318)', group: 'Gefahren', hint: 'DWD-Index, Stufe 1–5', source: 'dwd-open' },
  { id: 'fires', label: 'Feuer (Satellit)', color: '#e0521f', group: 'Gefahren', hint: 'Wärmeanomalien der letzten 24 h', source: 'firms' },
  { id: 'radiation', label: 'Strahlung (ODL)', color: '#7a5cc0', group: 'Gefahren', hint: 'Ortsdosisleistung, ~1700 Sonden', source: 'bfs' },
  { id: 'pegel', label: 'Pegel', color: 'var(--accent)', group: 'Gefahren', hint: 'Wasserstände mit Verlauf', source: 'pegelonline' },

  // Verkehr
  { id: 'flow', label: 'Verkehrsfluss', color: 'linear-gradient(90deg,#2c9e5b,#e0a90b,#c0392b)', group: 'Verkehr', needs: 'flow', source: 'tomtom' },
  { id: 'traffic', label: 'Verkehrsmeldungen', color: 'var(--sev3)', group: 'Verkehr', hint: 'Baustellen, Sperrungen, Staus', source: 'autobahn' },
  { id: 'vehicles', label: 'Busse & Bahnen', color: '#a92318', group: 'Verkehr', hint: 'Position aus dem Fahrplan gerechnet', source: 'transitous' },
  { id: 'stops', label: 'Haltestellen', color: '#1d4e73', group: 'Verkehr', hint: 'Bus, Tram, Bahn · ab Zoom 12', source: 'transitous' },
  { id: 'rest', label: 'Rastplätze & Laden', color: '#1d4e73', group: 'Verkehr', hint: 'Autobahn: Stellplätze und Ladepunkte', source: 'autobahn' },
  { id: 'aircraft', label: 'Flugzeuge', color: '#1d4e73', group: 'Verkehr', hint: 'ADS-B, ab Zoom 6', source: 'adsb' },
  { id: 'vessels', label: 'Schiffe', color: '#2c7448', group: 'Verkehr', hint: 'AIS', needs: 'ais', source: 'aisstream' },
  { id: 'aprs', label: 'Amateurfunk', color: '#6b3fa0', group: 'Verkehr', hint: 'feste Rufzeichenliste', needs: 'aprs', source: 'aprsfi' },

  // Lage
  { id: 'emergency', label: 'Notfallpunkte', color: '#a92318', group: 'Lage', hint: 'Klinik, Apotheke, Polizei, Feuerwehr — offline', source: 'osm' },
  { id: 'rescue', label: 'Rettungspunkte', color: '#1f8a4c', group: 'Lage', hint: 'nummerierte Schilder für den Notruf · ab Zoom 11', source: 'osm-overpass' },
  { id: 'avalanche', label: 'Lawinenlage', color: 'linear-gradient(90deg,#ccff66,#ffff00,#ff9900,#ff0000)', group: 'Gefahren', hint: 'Alpen und Bayern · nur in der Saison', source: 'eaws' },
  { id: 'quakes', label: 'Erdbeben', color: '#8a4b1d', group: 'Lage', hint: 'letzte Woche, ab Stärke 2,5', source: 'usgs' },
  { id: 'blaulicht', label: 'Blaulicht-Meldungen', color: '#1d4e73', group: 'Lage', hint: 'Polizei, Feuerwehr, THW · Presse, nicht live', source: 'presseportal' },
  { id: 'bosair', label: 'BOS-Luftfahrzeuge', color: '#c0392b', group: 'Lage', hint: 'Rettungs- und Polizeihubschrauber, live', source: 'adsb' },
  { id: 'news', label: 'Nachrichten', color: '#6a7580', group: 'Lage', hint: 'regionale Meldungen mit Ortsbezug', source: 'tagesschau' },
  // Startet als einzige Ebene AN: sie zeigt, was der Nutzer selbst angelegt
  // hat — das darf beim Öffnen der App nicht verschwunden sein.
  { id: 'draw', label: 'Meine Markierungen', color: '#0d9488', group: 'Lage', hint: 'eigene Punkte, Linien und Flächen' },
  { id: 'trails', label: 'Wander- und Radwege', color: '#1f7a4d', group: 'Verkehr', hint: 'ausgeschilderte Routen aus dem Routing-Paket · ab Zoom 10', source: 'osm' },
  { id: 'contours', label: 'Höhenlinien', color: '#8a6a3d', group: 'Lage', hint: 'aus dem Geländepaket gerechnet · Abstand nach Relief', source: 'terrain-tiles' },
  { id: 'terrain', label: 'Gelände', color: 'linear-gradient(90deg,#acd0a5,#e5e09a,#c49e79,#ebebf0)', group: 'Lage', hint: 'Höhen mit Schummerung — braucht das Geländepaket', source: 'terrain-tiles' },

  // Funk
  { id: 'muf', label: 'Ausbreitung (MUF)', color: 'linear-gradient(90deg,#3b4a7a,#2c8f6a,#d0a71a,#a4218c)', group: 'Funk', hint: 'Kurzwelle: höchste brauchbare Frequenz', source: 'kc2g' },
  { id: 'aurora', label: 'Polarlicht', color: '#3cba7a', group: 'Funk', hint: 'Wahrscheinlichkeit (NOAA)', source: 'noaa' },
];

/**
 * Warum eine Ebene gerade nicht zu haben ist. Steht in den Einstellungen an der
 * ausgegrauten Zeile — sonst rätselt man, warum sie im Karten-Menü fehlt.
 */
export const NEEDS_REASON: Record<NonNullable<LayerInfo['needs']>, string> = {
  flow: 'Braucht einen TomTom-Schlüssel auf dem Server',
  ais: 'Braucht einen aisstream.io-Schlüssel auf dem Server',
  aprs: 'Braucht einen aprs.fi-Schlüssel auf dem Server',
  lightning: 'Der Server empfängt gerade keine Blitze',
};

/** Ebenen, die man nicht ausblenden können soll — sonst fehlt die Grundlage. */
export const ALWAYS_SHOWN: LayerRowId[] = ['wind-labels'];
