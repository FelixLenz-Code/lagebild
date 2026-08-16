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
  | 'avalanche'
  | 'satellites'
  | 'drones'
  | 'water'
  | 'reach'
  | 'shadow';

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
 * Reihenfolge = Reihenfolge im Menü, und aus ihr ergeben sich auch die
 * Kategorien.
 *
 * Zugeschnitten wird nach der **Frage**, mit der man das Menü öffnet, nicht
 * nach der Herkunft der Daten: Wer wissen will, ob der Zug fährt, sucht nicht
 * unter „Verkehr" zwischen Flugzeugen und Schiffen. Deshalb lieber ein paar
 * kleine Kategorien mit klarem Namen als drei große Sammelbecken.
 */
export const LAYER_CATALOG: LayerInfo[] = [
  // Wetter — was vom Himmel kommt.
  { id: 'warnings', label: 'Unwetterwarnungen', color: '#a92318', group: 'Wetter', hint: 'amtlich vom DWD', source: 'dwd-geo' },
  { id: 'radar', label: 'Regenradar', color: '#3f83d4', group: 'Wetter', hint: 'Messung und Vorhersage bis +2 h', source: 'brightsky' },
  { id: 'lightning', label: 'Blitze', color: '#e3b505', group: 'Wetter', hint: 'Entladungen der letzten 30 Minuten', needs: 'lightning', source: 'blitzortung' },
  { id: 'wind', label: 'Wind', color: '#2c7448', group: 'Wetter', hint: 'Strömungsbild, 10 m über Grund', source: 'openmeteo' },
  { id: 'wind-labels', label: 'Windwerte', color: '#2c7448', group: 'Wetter', hint: 'km/h an den Gitterpunkten', sub: true },
  { id: 'webcams', label: 'Webcams', color: '#5b5b60', group: 'Wetter', hint: 'Panorama-Kameras · Bild auf der Betreiberseite', source: 'fotowebcam' },
  { id: 'night', label: 'Tag/Nacht', color: '#0b1a33', group: 'Wetter', hint: 'Dämmerungsgrenze, selbst gerechnet' },

  // Gefahren — was einem gefährlich werden kann, Wetter ausgenommen.
  { id: 'nina', label: 'Behördenwarnungen', color: '#6c2790', group: 'Gefahren', hint: 'MoWaS, KATWARN, BIWAPP, Polizei, Hochwasser', source: 'nina' },
  { id: 'pegel', label: 'Pegel', color: 'var(--accent)', group: 'Gefahren', hint: 'Wasserstände mit Verlauf', source: 'pegelonline' },
  { id: 'fire', label: 'Waldbrandgefahr', color: 'linear-gradient(90deg,#3f8f4a,#e3b505,#a92318)', group: 'Gefahren', hint: 'DWD-Index, Stufe 1–5', source: 'dwd-open' },
  { id: 'fires', label: 'Feuer (Satellit)', color: '#e0521f', group: 'Gefahren', hint: 'Wärmeanomalien der letzten 24 h', source: 'firms' },
  { id: 'avalanche', label: 'Lawinenlage', color: 'linear-gradient(90deg,#ccff66,#ffff00,#ff9900,#ff0000)', group: 'Gefahren', hint: 'Alpen und Bayern · nur in der Saison', source: 'eaws' },
  { id: 'radiation', label: 'Strahlung (ODL)', color: '#7a5cc0', group: 'Gefahren', hint: 'Ortsdosisleistung, ~1700 Sonden', source: 'bfs' },
  { id: 'quakes', label: 'Erdbeben', color: '#8a4b1d', group: 'Gefahren', hint: 'letzte Woche, ab Stärke 2,5', source: 'usgs' },

  // Straße — für die Fahrt.
  { id: 'traffic', label: 'Verkehrsmeldungen', color: 'var(--sev3)', group: 'Straße', hint: 'Baustellen, Sperrungen, Staus', source: 'autobahn' },
  { id: 'flow', label: 'Verkehrsfluss', color: 'linear-gradient(90deg,#2c9e5b,#e0a90b,#c0392b)', group: 'Straße', needs: 'flow', source: 'tomtom' },
  { id: 'rest', label: 'Rastplätze & Laden', color: '#1d4e73', group: 'Straße', hint: 'Autobahn: Stellplätze und Ladepunkte', source: 'autobahn' },
  { id: 'reach', label: 'Erreichbarkeit', color: 'linear-gradient(90deg,#2c7448,#e0a90b,#a92318)', group: 'Straße', hint: 'wie weit komme ich in 15, 30, 60 Minuten — im Gerät gerechnet', source: 'osm' },

  // Bahn & Bus — für alle, die nicht selbst fahren.
  { id: 'stops', label: 'Haltestellen', color: '#1d4e73', group: 'Bahn & Bus', hint: 'Bus, Tram, Bahn · ab Zoom 12', source: 'transitous' },
  { id: 'vehicles', label: 'Busse & Bahnen', color: '#a92318', group: 'Bahn & Bus', hint: 'Position aus dem Fahrplan gerechnet', source: 'transitous' },

  // Luft & Wasser.
  { id: 'aircraft', label: 'Flugzeuge', color: '#1d4e73', group: 'Luft & Wasser', hint: 'ADS-B, ab Zoom 6', source: 'adsb' },
  { id: 'vessels', label: 'Schiffe', color: '#2c7448', group: 'Luft & Wasser', hint: 'AIS', needs: 'ais', source: 'aisstream' },
  { id: 'drones', label: 'Drohnen-Zonen', color: '#6c2790', group: 'Luft & Wasser', hint: 'geografische Gebiete nach § 21h LuftVO · antippen für die Regel', source: 'dipul' },

  // Einsatzlage — was gerade läuft und wer unterwegs ist.
  { id: 'blaulicht', label: 'Blaulicht-Meldungen', color: '#1d4e73', group: 'Einsatzlage', hint: 'Polizei, Feuerwehr, THW · Presse, nicht live', source: 'presseportal' },
  { id: 'bosair', label: 'BOS-Luftfahrzeuge', color: '#c0392b', group: 'Einsatzlage', hint: 'Rettungs- und Polizeihubschrauber, live', source: 'adsb' },
  { id: 'news', label: 'Nachrichten', color: '#6a7580', group: 'Einsatzlage', hint: 'regionale Meldungen mit Ortsbezug', source: 'tagesschau' },

  // Anlaufstellen — wo es im Notfall Hilfe gibt.
  { id: 'emergency', label: 'Notfallpunkte', color: '#a92318', group: 'Anlaufstellen', hint: 'Klinik, Apotheke, Polizei, Feuerwehr — offline', source: 'osm' },
  { id: 'water', label: 'Löschwasser', color: '#1d6fa5', group: 'Anlaufstellen', hint: 'Hydranten, Saugstellen, Behälter aus OSM · ab Zoom 14', source: 'osm-overpass' },
  { id: 'rescue', label: 'Rettungspunkte', color: '#1f8a4c', group: 'Anlaufstellen', hint: 'nummerierte Schilder für den Notruf · ab Zoom 11', source: 'osm-overpass' },

  // Gelände & Wege — der Untergrund, auf dem alles liegt.
  { id: 'terrain', label: 'Gelände', color: 'linear-gradient(90deg,#acd0a5,#e5e09a,#c49e79,#ebebf0)', group: 'Gelände & Wege', hint: 'Höhen mit Schummerung — braucht das Geländepaket', source: 'terrain-tiles' },
  { id: 'contours', label: 'Höhenlinien', color: '#8a6a3d', group: 'Gelände & Wege', hint: 'aus dem Geländepaket gerechnet · Abstand nach Relief', source: 'terrain-tiles' },
  { id: 'shadow', label: 'Schattenwurf', color: '#3b4a7a', group: 'Gelände & Wege', hint: 'wo zur gewählten Zeit die Sonne nicht hinkommt — braucht das Geländepaket', source: 'terrain-tiles' },
  { id: 'trails', label: 'Wander- und Radwege', color: '#1f7a4d', group: 'Gelände & Wege', hint: 'ausgeschilderte Routen aus dem Routing-Paket · ab Zoom 10', source: 'osm' },

  // Funk — alles, was mit Wellen zu tun hat.
  { id: 'muf', label: 'Ausbreitung (MUF)', color: 'linear-gradient(90deg,#3b4a7a,#2c8f6a,#d0a71a,#a4218c)', group: 'Funk', hint: 'Kurzwelle: höchste brauchbare Frequenz', source: 'kc2g' },
  { id: 'satellites', label: 'Satelliten', color: '#d0a71a', group: 'Funk', hint: 'Position und Bodenspur — im Gerät gerechnet', source: 'celestrak' },
  { id: 'aprs', label: 'Amateurfunk', color: '#6b3fa0', group: 'Funk', hint: 'feste Rufzeichenliste', needs: 'aprs', source: 'aprsfi' },
  { id: 'aurora', label: 'Polarlicht', color: '#3cba7a', group: 'Funk', hint: 'Wahrscheinlichkeit (NOAA)', source: 'noaa' },

  // Eigenes — steht zuletzt, weil es als einzige Ebene von Anfang an an ist:
  // Wer etwas eingezeichnet hat, soll es beim Öffnen wiederfinden.
  { id: 'draw', label: 'Meine Markierungen', color: '#0d9488', group: 'Eigenes', hint: 'eigene Punkte, Linien und Flächen' },
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
