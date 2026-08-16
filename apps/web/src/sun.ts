/**
 * Sonnenstand, Auf-/Untergangszeiten und die Tag-/Nacht-Grenze (Terminator).
 * Standardverfahren nach den „Astronomical Algorithms" (Meeus), gekürzt auf
 * die Genauigkeit, die für Karte und Wetteransicht reicht (< 1 Minute).
 */

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
/** Schiefe der Ekliptik. */
const OBLIQUITY = 23.4397 * RAD;
/** Sonnenaufgang gilt bei dieser Höhe (Radius + Refraktion). */
export const HORIZON = -0.833 * RAD;
/** Ende der bürgerlichen Dämmerung. */
export const CIVIL_TWILIGHT = -6 * RAD;

const toDays = (date: Date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * DAY_MS);

const meanAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (m: number) =>
  m + RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m)) + RAD * 102.9372 + Math.PI;
const declination = (l: number) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(l));
const rightAscension = (l: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY), Math.cos(l));

interface SolarState {
  /** Sonnendeklination (rad). */
  dec: number;
  /** Länge des Subsolarpunkts (rad, −π…π) — dort steht die Sonne im Zenit. */
  subsolarLon: number;
  meanAnomaly: number;
  eclipticLon: number;
  days: number;
}

function solarState(date: Date): SolarState {
  const d = toDays(date);
  const m = meanAnomaly(d);
  const l = eclipticLongitude(m);
  const gmst = RAD * (280.16 + 360.9856235 * d);
  let lon = rightAscension(l) - gmst;
  lon = ((lon + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (lon < -Math.PI) lon += 2 * Math.PI;
  return { dec: declination(l), subsolarLon: lon, meanAnomaly: m, eclipticLon: l, days: d };
}

/** Sonnenhöhe über dem Horizont in Grad. */
export function sunAltitude(date: Date, lat: number, lon: number): number {
  const { dec, subsolarLon } = solarState(date);
  const h = lon * RAD - subsolarLon;
  const phi = lat * RAD;
  return (
    Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h)) / RAD
  );
}

/**
 * Sonnenazimut in Grad, von Nord über Ost gezählt (0 = Norden, 90 = Osten).
 *
 * Die Formel liefert den Stundenwinkel-Azimut ab Süden; für den Schattenwurf
 * und alles, was man auf eine Karte legt, ist die von Nord gezählte Richtung
 * die gebräuchliche — deshalb wird hier umgerechnet und nicht beim Aufrufer.
 */
export function sunAzimuth(date: Date, lat: number, lon: number): number {
  const { dec, subsolarLon } = solarState(date);
  const h = lon * RAD - subsolarLon;
  const phi = lat * RAD;
  const south = Math.atan2(Math.sin(h), Math.cos(h) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  return (south / RAD + 180 + 360) % 360;
}

/** Sonnenauf- und -untergang des Tages von `date` an einem Ort. */
export function sunTimes(date: Date, lat: number, lon: number): { sunrise: Date | null; sunset: Date | null } {
  const lw = -lon * RAD;
  const phi = lat * RAD;
  const d = toDays(date);

  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const m = meanAnomaly(ds);
  const l = eclipticLongitude(m);
  const dec = declination(l);
  const noon = J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);

  const cosH = (Math.sin(HORIZON) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  // Polartag/-nacht: die Sonne über- bzw. unterschreitet den Horizont nicht.
  if (cosH > 1 || cosH < -1) return { sunrise: null, sunset: null };

  const setJ =
    J2000 +
    (0.0009 + (Math.acos(cosH) + lw) / (2 * Math.PI) + n) +
    0.0053 * Math.sin(m) -
    0.0069 * Math.sin(2 * l);
  return { sunrise: fromJulian(noon - (setJ - noon)), sunset: fromJulian(setJ) };
}

/**
 * Fläche, in der die Sonne tiefer als `altitude` (rad) steht — als GeoJSON.
 * Die Grenze wird für jeden Längengrad-Schritt gelöst; geschlossen wird über
 * den Pol, der gerade im Dunkeln liegt.
 */
export function shadowPolygon(date: Date, altitude = HORIZON, stepDeg = 1): GeoJSON.Feature {
  const { dec, subsolarLon } = solarState(date);
  const darkPole = dec > 0 ? -90 : 90;
  const ring: [number, number][] = [];

  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const h = lon * RAD - subsolarLon;
    // sin(alt) = sin φ · sin δ + cos φ · cos δ · cos H  →  nach φ auflösen.
    const a = Math.sin(dec);
    const b = Math.cos(dec) * Math.cos(h);
    const r = Math.hypot(a, b);
    const ratio = Math.max(-1, Math.min(1, Math.sin(altitude) / r));
    const lat = (Math.asin(ratio) - Math.atan2(b, a)) / RAD;
    ring.push([lon, Math.max(-89.9, Math.min(89.9, lat))]);
  }

  ring.push([180, darkPole], [-180, darkPole], ring[0]!);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}
