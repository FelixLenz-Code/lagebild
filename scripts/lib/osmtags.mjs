/**
 * Auswertung der OSM-Tags: Straßenklassen, Zugang je Profil, Geschwindigkeiten
 * und die Kategorien für die Ortssuche.
 *
 * Die Klassen- und Kategorienlisten wandern in den Kopf der erzeugten Dateien,
 * damit das Frontend keine zweite Kopie pflegen muss.
 */

/** Straßenklassen (Index = Wert in edgeClass). */
export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'pedestrian',
  'track',
  'path',
  'footway',
  'cycleway',
  'steps',
  'ferry',
];
const CLASS_INDEX = new Map(ROAD_CLASSES.map((c, i) => [c, i]));

/** highway=… → Klasse (Zubringer erben die Klasse ihrer Straße). */
const HIGHWAY_MAP = {
  motorway: ['motorway', false],
  motorway_link: ['motorway', true],
  trunk: ['trunk', false],
  trunk_link: ['trunk', true],
  primary: ['primary', false],
  primary_link: ['primary', true],
  secondary: ['secondary', false],
  secondary_link: ['secondary', true],
  tertiary: ['tertiary', false],
  tertiary_link: ['tertiary', true],
  unclassified: ['unclassified', false],
  residential: ['residential', false],
  living_street: ['living_street', false],
  service: ['service', false],
  pedestrian: ['pedestrian', false],
  track: ['track', false],
  path: ['path', false],
  bridleway: ['path', false],
  footway: ['footway', false],
  cycleway: ['cycleway', false],
  steps: ['steps', false],
  road: ['unclassified', false],
};

/** Voreingestellte Kfz-Geschwindigkeit je Klasse (km/h). */
const DEFAULT_SPEED = {
  motorway: 130,
  trunk: 100,
  primary: 90,
  secondary: 80,
  tertiary: 70,
  unclassified: 60,
  residential: 40,
  living_street: 10,
  service: 20,
  pedestrian: 0,
  track: 20,
  path: 0,
  footway: 0,
  cycleway: 0,
  steps: 0,
  ferry: 20,
};

/** Bitmaske der Kantenmerkmale (identisch im Frontend). */
export const FLAG = {
  CAR_F: 1,
  CAR_B: 2,
  BIKE_F: 4,
  BIKE_B: 8,
  FOOT_F: 16,
  FOOT_B: 32,
  ROUNDABOUT: 64,
  LINK: 128,
};

const NO = new Set(['no', 'private', 'agricultural', 'forestry', 'delivery', 'military']);
const YES = new Set(['yes', 'designated', 'permissive', 'destination', 'official', 'customers']);

/** „50", „30 mph", „walk", „none", „DE:urban" → km/h (oder null). */
export function parseMaxspeed(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'none') return 130;
  if (v === 'walk') return 7;
  if (v === 'de:urban' || v === 'urban') return 50;
  if (v === 'de:rural' || v === 'rural') return 100;
  if (v === 'de:motorway') return 130;
  if (v === 'de:living_street') return 7;
  const mph = v.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mph) return Math.round(Number(mph[1]) * 1.609);
  const kmh = v.match(/^(\d+(?:\.\d+)?)/);
  if (kmh) {
    const n = Number(kmh[1]);
    if (n > 0 && n <= 200) return Math.round(n);
  }
  return null;
}

/**
 * Klassifiziert einen Weg fürs Routing.
 * @returns {{cls:number, flags:number, speed:number, name:string|null}|null}
 */
export function classifyRoad(tags) {
  const hw = tags.highway;
  let name = tags.name ?? tags.ref ?? null;
  let cls;
  let link = false;
  if (hw) {
    const m = HIGHWAY_MAP[hw];
    if (!m) return null;
    cls = m[0];
    link = m[1];
  } else if (tags.route === 'ferry' && (tags.motor_vehicle !== 'no' || tags.foot === 'yes')) {
    cls = 'ferry';
    name = name ?? 'Fähre';
  } else {
    return null;
  }
  // Im Bau/geplant/aufgegeben → nicht befahrbar.
  if (tags.construction || tags.proposed || tags.abandoned === 'yes' || tags.disused === 'yes') return null;

  const general = tags.access;
  const carTag = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? general;
  const bikeTag = tags.bicycle ?? tags.vehicle ?? general;
  const footTag = tags.foot ?? general;

  // Grundsätzliche Eignung je Klasse …
  let car = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'ferry'].includes(cls);
  let bike = !['motorway', 'steps'].includes(cls) && !(cls === 'footway' && !YES.has(bikeTag ?? ''));
  let foot = !['motorway', 'cycleway'].includes(cls) || YES.has(footTag ?? '');
  if (cls === 'cycleway') foot = footTag ? !NO.has(footTag) : true;
  if (cls === 'track') car = tags.motor_vehicle ? !NO.has(tags.motor_vehicle) : false;
  if (cls === 'pedestrian') car = carTag === 'destination' || carTag === 'yes';

  // … dann die ausdrücklichen Zugangs-Tags.
  if (carTag && NO.has(carTag)) car = false;
  if (carTag && YES.has(carTag) && cls !== 'footway' && cls !== 'path' && cls !== 'steps') car = true;
  if (bikeTag && NO.has(bikeTag)) bike = false;
  if (bikeTag && YES.has(bikeTag)) bike = true;
  if (footTag && NO.has(footTag)) foot = false;
  if (footTag && YES.has(footTag)) foot = true;
  // Kraftfahrstraßen sind für Rad und Fuß gesperrt.
  if (tags.motorroad === 'yes' || cls === 'motorway') {
    bike = false;
    foot = false;
  }
  if (!car && !bike && !foot) return null;

  // Einbahnstraße (Auto/Rad getrennt, zu Fuß immer beidseitig).
  const ow = tags.oneway;
  const roundabout = tags.junction === 'roundabout' || tags.junction === 'circular';
  let carF = car;
  let carB = car;
  if (ow === 'yes' || ow === 'true' || ow === '1') carB = false;
  else if (ow === '-1' || ow === 'reverse') carF = false;
  else if ((roundabout || cls === 'motorway') && ow !== 'no') carB = false;

  let bikeF = bike;
  let bikeB = bike;
  const owBike = tags['oneway:bicycle'];
  if (owBike === 'no') {
    // ausdrücklich freigegeben — Gegenrichtung bleibt erlaubt
  } else if (owBike === 'yes') {
    bikeB = false;
  } else if (!carB && (ow === 'yes' || ow === 'true' || ow === '1')) {
    const opp =
      tags['cycleway'] === 'opposite' ||
      tags['cycleway:left'] === 'opposite' ||
      tags['cycleway:right'] === 'opposite' ||
      tags['cycleway'] === 'opposite_lane' ||
      tags['cycleway'] === 'opposite_track';
    if (!opp && cls !== 'path' && cls !== 'footway' && cls !== 'cycleway') bikeB = false;
  } else if (!carF && (ow === '-1' || ow === 'reverse')) {
    bikeF = false;
  }

  let flags = 0;
  if (carF) flags |= FLAG.CAR_F;
  if (carB) flags |= FLAG.CAR_B;
  if (bikeF) flags |= FLAG.BIKE_F;
  if (bikeB) flags |= FLAG.BIKE_B;
  if (foot) flags |= FLAG.FOOT_F | FLAG.FOOT_B;
  if (roundabout) flags |= FLAG.ROUNDABOUT;
  if (link) flags |= FLAG.LINK;

  let speed = parseMaxspeed(tags.maxspeed) ?? DEFAULT_SPEED[cls];
  if (link && speed > 60) speed = Math.round(speed * 0.6);
  if (cls === 'ferry') speed = 20;
  if (!car) speed = 0;

  return { cls: CLASS_INDEX.get(cls), flags, speed: Math.min(255, speed), name };
}

/* ------------------------------------------------------------------ */
/* Kategorien für die Suche                                            */
/* ------------------------------------------------------------------ */

/**
 * POI-Kategorien: key → { label (Suchwort + Anzeige), icon }.
 * Die Liste landet im Kopf der Suchdatei; das Frontend liest sie von dort.
 */
export const CATEGORIES = {
  fuel: { label: 'Tankstelle', icon: 'fuel' },
  charging: { label: 'Ladesäule', icon: 'fuel' },
  parking: { label: 'Parkplatz', icon: 'parking' },
  pharmacy: { label: 'Apotheke', icon: 'health' },
  hospital: { label: 'Krankenhaus', icon: 'health' },
  doctor: { label: 'Arztpraxis', icon: 'health' },
  police: { label: 'Polizei', icon: 'shield' },
  fire_station: { label: 'Feuerwehr', icon: 'shield' },
  supermarket: { label: 'Supermarkt', icon: 'cart' },
  bakery: { label: 'Bäckerei', icon: 'cart' },
  shop: { label: 'Geschäft', icon: 'cart' },
  restaurant: { label: 'Restaurant', icon: 'food' },
  cafe: { label: 'Café', icon: 'food' },
  fast_food: { label: 'Imbiss', icon: 'food' },
  bar: { label: 'Bar', icon: 'food' },
  hotel: { label: 'Hotel', icon: 'bed' },
  atm: { label: 'Geldautomat', icon: 'bank' },
  bank: { label: 'Bank', icon: 'bank' },
  post: { label: 'Post', icon: 'mail' },
  toilets: { label: 'Toilette', icon: 'wc' },
  drinking_water: { label: 'Trinkwasser', icon: 'water' },
  school: { label: 'Schule', icon: 'school' },
  kindergarten: { label: 'Kindergarten', icon: 'school' },
  university: { label: 'Hochschule', icon: 'school' },
  station: { label: 'Bahnhof', icon: 'train' },
  tram_stop: { label: 'Haltestelle', icon: 'train' },
  bus_stop: { label: 'Bushaltestelle', icon: 'bus' },
  airport: { label: 'Flughafen', icon: 'plane' },
  ferry_terminal: { label: 'Fähranleger', icon: 'ship' },
  harbour: { label: 'Hafen', icon: 'ship' },
  townhall: { label: 'Rathaus', icon: 'building' },
  church: { label: 'Kirche', icon: 'church' },
  museum: { label: 'Museum', icon: 'museum' },
  viewpoint: { label: 'Aussichtspunkt', icon: 'view' },
  peak: { label: 'Berggipfel', icon: 'peak' },
  camp: { label: 'Campingplatz', icon: 'tent' },
  playground: { label: 'Spielplatz', icon: 'play' },
  sports: { label: 'Sportanlage', icon: 'sport' },
  swimming: { label: 'Schwimmbad', icon: 'sport' },
  park: { label: 'Park', icon: 'tree' },
  forest: { label: 'Wald', icon: 'tree' },
  water: { label: 'Gewässer', icon: 'water' },
  shelter: { label: 'Schutzhütte', icon: 'shelter' },
  rest_area: { label: 'Rastplatz', icon: 'rest' },
  workshop: { label: 'Werkstatt', icon: 'tool' },
  recycling: { label: 'Wertstoffhof', icon: 'recycle' },
  place: { label: 'Ort', icon: 'place' },
  street: { label: 'Straße', icon: 'street' },
  address: { label: 'Adresse', icon: 'address' },
  poi: { label: 'Punkt', icon: 'pin' },
};
export const CATEGORY_KEYS = Object.keys(CATEGORIES);
const CATEGORY_INDEX = new Map(CATEGORY_KEYS.map((k, i) => [k, i]));
export const catIndex = (key) => CATEGORY_INDEX.get(key) ?? CATEGORY_INDEX.get('poi');

/** amenity/shop/… → Kategorie-Schlüssel (oder null, wenn uninteressant). */
export function poiCategory(tags) {
  const a = tags.amenity;
  if (a) {
    if (a === 'fuel') return 'fuel';
    if (a === 'charging_station') return 'charging';
    if (a === 'parking') return tags.access && NO.has(tags.access) ? null : 'parking';
    if (a === 'pharmacy') return 'pharmacy';
    if (a === 'hospital' || a === 'clinic') return 'hospital';
    if (a === 'doctors' || a === 'dentist') return 'doctor';
    if (a === 'police') return 'police';
    if (a === 'fire_station') return 'fire_station';
    if (a === 'restaurant') return 'restaurant';
    if (a === 'cafe' || a === 'ice_cream') return 'cafe';
    if (a === 'fast_food') return 'fast_food';
    if (a === 'bar' || a === 'pub' || a === 'biergarten') return 'bar';
    if (a === 'atm') return 'atm';
    if (a === 'bank') return 'bank';
    if (a === 'post_office' || a === 'post_box') return 'post';
    if (a === 'toilets') return 'toilets';
    if (a === 'drinking_water') return 'drinking_water';
    if (a === 'school') return 'school';
    if (a === 'kindergarten') return 'kindergarten';
    if (a === 'university' || a === 'college') return 'university';
    if (a === 'townhall') return 'townhall';
    if (a === 'place_of_worship') return 'church';
    if (a === 'ferry_terminal') return 'ferry_terminal';
    if (a === 'shelter') return 'shelter';
    if (a === 'recycling') return 'recycling';
    if (a === 'car_repair') return 'workshop';
    return null;
  }
  if (tags.shop) {
    if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'supermarket';
    if (tags.shop === 'bakery' || tags.shop === 'butcher') return 'bakery';
    if (tags.shop === 'car_repair') return 'workshop';
    return 'shop';
  }
  if (tags.tourism) {
    if (tags.tourism === 'hotel' || tags.tourism === 'hostel' || tags.tourism === 'guest_house') return 'hotel';
    if (tags.tourism === 'museum') return 'museum';
    if (tags.tourism === 'viewpoint') return 'viewpoint';
    if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') return 'camp';
    return null;
  }
  if (tags.leisure) {
    if (tags.leisure === 'playground') return 'playground';
    if (tags.leisure === 'swimming_pool' || tags.leisure === 'water_park') return 'swimming';
    if (tags.leisure === 'sports_centre' || tags.leisure === 'pitch' || tags.leisure === 'stadium') return 'sports';
    if (tags.leisure === 'park' || tags.leisure === 'garden') return 'park';
    return null;
  }
  if (tags.healthcare) return tags.healthcare === 'pharmacy' ? 'pharmacy' : 'doctor';
  if (tags.railway === 'station' || tags.railway === 'halt') return 'station';
  if (tags.railway === 'tram_stop') return 'tram_stop';
  if (tags.highway === 'bus_stop') return 'bus_stop';
  if (tags.highway === 'rest_area' || tags.highway === 'services') return 'rest_area';
  if (tags.aeroway === 'aerodrome') return 'airport';
  if (tags.harbour === 'yes' || tags.landuse === 'harbour') return 'harbour';
  if (tags.natural === 'peak') return 'peak';
  if (tags.natural === 'water' || tags.waterway === 'riverbank') return 'water';
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'forest';
  if (tags.historic === 'castle' || tags.historic === 'monument' || tags.historic === 'memorial') return 'museum';
  if (tags.emergency === 'phone') return null;
  return null;
}

/** Ortsränge (place=…) mit Gewicht für die Zuordnung „nächster Ort". */
export const PLACE_RANK = {
  city: 4,
  town: 2.5,
  village: 1.2,
  suburb: 1.0,
  borough: 1.2,
  quarter: 0.7,
  hamlet: 0.6,
  isolated_dwelling: 0.3,
  municipality: 2,
};

/**
 * Normalisiert Text für die Suche: Kleinschreibung, Umlaute aufgelöst,
 * „str." → „strasse", Satzzeichen weg.
 */
export function normalize(s) {
  return s
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/str\.(?=\s|$)/g, 'strasse')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Zerlegt einen normalisierten Namen in Suchbegriffe (inkl. „…strasse" → „…"). */
export function terms(name) {
  const out = new Set();
  const norm = normalize(name);
  if (!norm) return out;
  for (const t of norm.split(' ')) {
    if (!t) continue;
    out.add(t);
    // „bahnhofstrasse" soll auch auf „bahnhof" ansprechen.
    const m = t.match(/^(.{3,})(strasse|str|weg|platz|allee|gasse|damm|ring|ufer)$/);
    if (m) out.add(m[1]);
  }
  return out;
}
