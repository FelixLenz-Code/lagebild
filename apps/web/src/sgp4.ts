/**
 * SGP4 — Bahnrechnung für erdnahe Satelliten, auf dem Gerät.
 *
 * Aus zwei Zeilen Bahnelementen (TLE) und einem Zeitpunkt wird die Position im
 * Raum. Das Verfahren ist das der NORAD-Veröffentlichung „Spacetrack Report
 * No. 3" mit den Korrekturen von Vallado; gerechnet wird die **erdnahe**
 * Variante. Für Bahnen mit einer Umlaufzeit über 225 Minuten (geostationär,
 * Molnija) bräuchte es zusätzlich SDP4 mit Sonne- und Mondstörungen — die
 * kommen hier nicht vor, und solche Satelliten „gehen" auch nicht auf.
 *
 * Warum selbst rechnen: Damit die Überflüge **ohne Netz** vorhersagbar sind.
 * Bahnelemente gelten Tage; einmal geladen, braucht die Vorhersage niemanden
 * mehr.
 */

/* --- Konstanten des Modells (WGS-72, wie SGP4 sie verlangt) --- */
const PI2 = Math.PI * 2;
const DEG = Math.PI / 180;
/** Erdradius in Kilometern. */
export const EARTH_RADIUS_KM = 6378.135;
/** Wurzel aus GM in Erdradien^1,5 je Minute. */
const XKE = 0.0743669161331734132;
const J2 = 0.001082616;
const J3 = -0.00000253881;
const J4 = -0.00000165597;
const K2 = 0.5 * J2;
const K4 = (-3 / 8) * J4;
const A3OVK2 = -J3 / K2;
/** Höhe der Atmosphärengrenze im Widerstandsmodell (Erdradien). */
const QOMS2T = ((120 - 78) / EARTH_RADIUS_KM) ** 4;
const S = 1 + 78 / EARTH_RADIUS_KM;

export interface Tle {
  name: string;
  line1: string;
  line2: string;
  group?: string;
}

/** Vorbereitete Bahn — die Aufbereitung lohnt sich, sie gilt für alle Zeiten. */
export interface Satrec {
  name: string;
  /** NORAD-Katalognummer. */
  id: string;
  /** Epoche der Elemente in Millisekunden. */
  epochMs: number;
  /** Umlaufzeit in Minuten. */
  periodMin: number;
  simple: boolean;
  no: number;
  ecco: number;
  inclo: number;
  nodeo: number;
  argpo: number;
  mo: number;
  bstar: number;
  aodp: number;
  xnodp: number;
  cosio: number;
  sinio: number;
  x3thm1: number;
  x1mth2: number;
  x7thm1: number;
  xmdot: number;
  omgdot: number;
  xnodot: number;
  xnodcf: number;
  t2cof: number;
  xlcof: number;
  aycof: number;
  c1: number;
  c4: number;
  c5: number;
  eta: number;
  omgcof: number;
  xmcof: number;
  delmo: number;
  sinmo: number;
  d2: number;
  d3: number;
  d4: number;
  t3cof: number;
  t4cof: number;
  t5cof: number;
}

/** Zahl im TLE-Exponentenformat („ 12345-3" = 0,12345e-3). */
function expNumber(field: string): number {
  const s = field.trim();
  if (!s || s === '0' || s === '00000-0' || s === '00000+0') return 0;
  const sign = s.startsWith('-') ? -1 : 1;
  const body = s.replace(/^[+-]/, '');
  const m = body.match(/^(\d+)([+-]\d)$/);
  if (!m) return sign * Number(`0.${body}`);
  return sign * Number(`0.${m[1]}`) * 10 ** Number(m[2]);
}

/** Epoche aus Jahr + Tagesbruchteil des TLE. */
function epochToMs(yy: number, days: number): number {
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const start = Date.UTC(year, 0, 1);
  return start + (days - 1) * 86400000;
}

/** Bahnelemente aufbereiten. Gibt `null`, wenn die Zeilen unbrauchbar sind. */
export function initSat(tle: Tle): Satrec | null {
  const l1 = tle.line1;
  const l2 = tle.line2;
  if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) return null;

  const bstar = expNumber(l1.slice(53, 61));
  const epochYear = Number(l1.slice(18, 20));
  const epochDays = Number(l1.slice(20, 32));
  const inclo = Number(l2.slice(8, 16)) * DEG;
  const nodeo = Number(l2.slice(17, 25)) * DEG;
  const ecco = Number(`0.${l2.slice(26, 33).trim()}`);
  const argpo = Number(l2.slice(34, 42)) * DEG;
  const mo = Number(l2.slice(43, 51)) * DEG;
  const revsPerDay = Number(l2.slice(52, 63));
  if (![epochYear, epochDays, inclo, nodeo, ecco, argpo, mo, revsPerDay].every(Number.isFinite)) return null;
  if (ecco < 0 || ecco >= 1 || revsPerDay <= 0) return null;

  const no = (revsPerDay * PI2) / 1440;

  /* --- ursprüngliche mittlere Bewegung und große Halbachse zurückrechnen --- */
  const a1 = (XKE / no) ** (2 / 3);
  const cosio = Math.cos(inclo);
  const theta2 = cosio * cosio;
  const x3thm1 = 3 * theta2 - 1;
  const eosq = ecco * ecco;
  const betao2 = 1 - eosq;
  const betao = Math.sqrt(betao2);
  const del1 = (1.5 * K2 * x3thm1) / (a1 * a1 * betao * betao2);
  const ao = a1 * (1 - del1 * (1 / 3 + del1 * (1 + (134 / 81) * del1)));
  const delo = (1.5 * K2 * x3thm1) / (ao * ao * betao * betao2);
  const xnodp = no / (1 + delo);
  const aodp = ao / (1 - delo);

  const periodMin = PI2 / xnodp;
  // Tiefer Raum (Umlaufzeit ≥ 225 min) ist nicht abgedeckt — lieber nichts
  // liefern als eine Zahl, die um Grad danebenliegt.
  if (periodMin >= 225) return null;

  const simple = (aodp * (1 - ecco)) / 1 < 220 / EARTH_RADIUS_KM + 1;

  /* --- Widerstandsterme --- */
  const perigee = (aodp * (1 - ecco) - 1) * EARTH_RADIUS_KM;
  let s4 = S;
  let qoms24 = QOMS2T;
  if (perigee < 156) {
    s4 = perigee - 78;
    if (perigee <= 98) s4 = 20;
    qoms24 = ((120 - s4) / EARTH_RADIUS_KM) ** 4;
    s4 = s4 / EARTH_RADIUS_KM + 1;
  }

  const pinvsq = 1 / (aodp * aodp * betao2 * betao2);
  const tsi = 1 / (aodp - s4);
  const eta = aodp * ecco * tsi;
  const etasq = eta * eta;
  const eeta = ecco * eta;
  const psisq = Math.abs(1 - etasq);
  const coef = qoms24 * tsi ** 4;
  const coef1 = coef / psisq ** 3.5;
  const c2 =
    coef1 *
    xnodp *
    (aodp * (1 + 1.5 * etasq + eeta * (4 + etasq)) +
      ((0.75 * K2 * tsi) / psisq) * x3thm1 * (8 + 3 * etasq * (8 + etasq)));
  const c1 = bstar * c2;
  const sinio = Math.sin(inclo);
  const c3 = ecco > 1e-4 ? (coef * tsi * A3OVK2 * xnodp * sinio) / ecco : 0;
  const x1mth2 = 1 - theta2;
  const c4 =
    2 *
    xnodp *
    coef1 *
    aodp *
    betao2 *
    (eta * (2 + 0.5 * etasq) +
      ecco * (0.5 + 2 * etasq) -
      ((2 * K2 * tsi) / (aodp * psisq)) *
        (-3 * x3thm1 * (1 - 2 * eeta + etasq * (1.5 - 0.5 * eeta)) +
          0.75 * x1mth2 * (2 * etasq - eeta * (1 + etasq)) * Math.cos(2 * argpo)));
  const c5 = 2 * coef1 * aodp * betao2 * (1 + 2.75 * (etasq + eeta) + eeta * etasq);

  const theta4 = theta2 * theta2;
  const temp1 = 3 * K2 * pinvsq * xnodp;
  const temp2 = temp1 * K2 * pinvsq;
  const temp3 = 1.25 * K4 * pinvsq * pinvsq * xnodp;
  const xmdot =
    xnodp + 0.5 * temp1 * betao * x3thm1 + 0.0625 * temp2 * betao * (13 - 78 * theta2 + 137 * theta4);
  const x1m5th = 1 - 5 * theta2;
  const omgdot =
    -0.5 * temp1 * x1m5th +
    0.0625 * temp2 * (7 - 114 * theta2 + 395 * theta4) +
    temp3 * (3 - 36 * theta2 + 49 * theta4);
  const xhdot1 = -temp1 * cosio;
  const xnodot =
    xhdot1 + (0.5 * temp2 * (4 - 19 * theta2) + 2 * temp3 * (3 - 7 * theta2)) * cosio;

  const omgcof = bstar * c3 * Math.cos(argpo);
  const xmcof = ecco > 1e-4 ? ((-2 / 3) * coef * bstar) / eeta : 0;
  const xnodcf = 3.5 * betao2 * xhdot1 * c1;
  const t2cof = 1.5 * c1;
  const xlcof = (0.125 * A3OVK2 * sinio * (3 + 5 * cosio)) / (1 + cosio);
  const aycof = 0.25 * A3OVK2 * sinio;
  const delmo = (1 + eta * Math.cos(mo)) ** 3;

  let d2 = 0;
  let d3 = 0;
  let d4 = 0;
  let t3cof = 0;
  let t4cof = 0;
  let t5cof = 0;
  if (!simple) {
    const c1sq = c1 * c1;
    d2 = 4 * aodp * tsi * c1sq;
    const temp = (d2 * tsi * c1) / 3;
    d3 = (17 * aodp + s4) * temp;
    d4 = 0.5 * temp * aodp * tsi * (221 * aodp + 31 * s4) * c1;
    t3cof = d2 + 2 * c1sq;
    t4cof = 0.25 * (3 * d3 + c1 * (12 * d2 + 10 * c1sq));
    t5cof = 0.2 * (3 * d4 + 12 * c1 * d3 + 6 * d2 * d2 + 15 * c1sq * (2 * d2 + c1sq));
  }

  return {
    name: tle.name,
    id: l1.slice(2, 7).trim(),
    epochMs: epochToMs(epochYear, epochDays),
    periodMin,
    simple,
    no,
    ecco,
    inclo,
    nodeo,
    argpo,
    mo,
    bstar,
    aodp,
    xnodp,
    cosio,
    sinio,
    x3thm1,
    x1mth2,
    x7thm1: 7 * theta2 - 1,
    xmdot,
    omgdot,
    xnodot,
    xnodcf,
    t2cof,
    xlcof,
    aycof,
    c1,
    c4,
    c5,
    eta,
    omgcof,
    xmcof,
    delmo,
    sinmo: Math.sin(mo),
    d2,
    d3,
    d4,
    t3cof,
    t4cof,
    t5cof,
  };
}

/** Ort im erdfesten TEME-System, in Kilometern. */
export interface Eci {
  x: number;
  y: number;
  z: number;
}

/**
 * Position zu einem Zeitpunkt (Minuten seit der Epoche der Elemente).
 * Ergebnis in TEME-Koordinaten, Kilometer.
 */
export function propagate(sat: Satrec, tMin: number): Eci | null {
  const xmdf = sat.mo + sat.xmdot * tMin;
  const omgadf = sat.argpo + sat.omgdot * tMin;
  const xnoddf = sat.nodeo + sat.xnodot * tMin;
  let omega = omgadf;
  let xmp = xmdf;
  const tsq = tMin * tMin;
  const xnode = xnoddf + sat.xnodcf * tsq;
  let tempa = 1 - sat.c1 * tMin;
  let tempe = sat.bstar * sat.c4 * tMin;
  let templ = sat.t2cof * tsq;

  if (!sat.simple) {
    const delomg = sat.omgcof * tMin;
    const delm = sat.xmcof * ((1 + sat.eta * Math.cos(xmdf)) ** 3 - sat.delmo);
    const temp = delomg + delm;
    xmp = xmdf + temp;
    omega = omgadf - temp;
    const t3 = tsq * tMin;
    const t4 = t3 * tMin;
    tempa = tempa - sat.d2 * tsq - sat.d3 * t3 - sat.d4 * t4;
    tempe += sat.bstar * sat.c5 * (Math.sin(xmp) - sat.sinmo);
    templ += sat.t3cof * t3 + t4 * (sat.t4cof + tMin * sat.t5cof);
  }

  const a = sat.aodp * tempa * tempa;
  const e = sat.ecco - tempe;
  // Bei zu großer Abweichung ist die Bahn abgestürzt bzw. das Modell verlassen.
  if (a < 1 || e < -0.001 || e >= 1) return null;
  const xl = xmp + omega + xnode + sat.xnodp * templ;
  const beta2 = 1 - e * e;

  /* --- langperiodische Anteile --- */
  const axn = e * Math.cos(omega);
  const temp0 = 1 / (a * beta2);
  const xll = temp0 * sat.xlcof * axn;
  const aynl = temp0 * sat.aycof;
  const xlt = xl + xll;
  const ayn = e * Math.sin(omega) + aynl;

  /* --- Kepler-Gleichung --- */
  const capu = ((xlt - xnode) % PI2 + PI2) % PI2;
  let epw = capu;
  let sinepw = 0;
  let cosepw = 0;
  let temp5 = 0;
  let temp6 = 0;
  let temp3 = 0;
  let temp4 = 0;
  for (let i = 0; i < 12; i++) {
    sinepw = Math.sin(epw);
    cosepw = Math.cos(epw);
    temp3 = axn * sinepw;
    temp4 = ayn * cosepw;
    temp5 = axn * cosepw;
    temp6 = ayn * sinepw;
    const next = (capu - temp4 + temp3 - epw) / (1 - temp5 - temp6) + epw;
    if (Math.abs(next - epw) < 1e-12) {
      epw = next;
      sinepw = Math.sin(epw);
      cosepw = Math.cos(epw);
      temp3 = axn * sinepw;
      temp4 = ayn * cosepw;
      temp5 = axn * cosepw;
      temp6 = ayn * sinepw;
      break;
    }
    epw = next;
  }

  /* --- kurzperiodische Anteile --- */
  const ecose = temp5 + temp6;
  const esine = temp3 - temp4;
  const elsq = axn * axn + ayn * ayn;
  const tempA = 1 - elsq;
  const pl = a * tempA;
  const r = a * (1 - ecose);
  const invR = 1 / r;
  // Geschwindigkeit wird hier nicht gebraucht — für Auf- und Untergang zählt
  // allein der Ort. Das spart in der Überflugsuche Millionen Wurzeln.
  const tempB = a * invR;
  const betal = Math.sqrt(tempA);
  const tempC = 1 / (1 + betal);
  const cosu = tempB * (cosepw - axn + ayn * esine * tempC);
  const sinu = tempB * (sinepw - ayn - axn * esine * tempC);
  const u = Math.atan2(sinu, cosu);
  const sin2u = 2 * sinu * cosu;
  const cos2u = 1 - 2 * sinu * sinu;
  const tempD = 1 / pl;
  const tempE = K2 * tempD;
  const tempF = tempE * tempD;

  const rk = r * (1 - 1.5 * tempF * betal * sat.x3thm1) + 0.5 * tempE * sat.x1mth2 * cos2u;
  const uk = u - 0.25 * tempF * sat.x7thm1 * sin2u;
  const xnodek = xnode + 1.5 * tempF * sat.cosio * sin2u;
  const xinck = sat.inclo + 1.5 * tempF * sat.cosio * sat.sinio * cos2u;

  const sinuk = Math.sin(uk);
  const cosuk = Math.cos(uk);
  const sinik = Math.sin(xinck);
  const cosik = Math.cos(xinck);
  const sinnok = Math.sin(xnodek);
  const cosnok = Math.cos(xnodek);
  const xmx = -sinnok * cosik;
  const xmy = cosnok * cosik;
  const ux = xmx * sinuk + cosnok * cosuk;
  const uy = xmy * sinuk + sinnok * cosuk;
  const uz = sinik * sinuk;

  return {
    x: rk * ux * EARTH_RADIUS_KM,
    y: rk * uy * EARTH_RADIUS_KM,
    z: rk * uz * EARTH_RADIUS_KM,
  };
}

/**
 * Sternzeit von Greenwich (rad) — sie dreht das erdfeste Koordinatensystem
 * unter der Bahn hinweg. Formel nach IAU 1982, für unsere Zwecke genau genug.
 */
export function gmst(ms: number): number {
  const jd = ms / 86400000 + 2440587.5;
  const t = (jd - 2451545) / 36525;
  let g =
    67310.54841 +
    (876600 * 3600 + 8640184.812866) * t +
    0.093104 * t * t -
    6.2e-6 * t * t * t;
  g = ((g % 86400) * PI2) / 86400;
  return ((g % PI2) + PI2) % PI2;
}

export interface LookAngle {
  /** Azimut in Grad (0 = Nord, im Uhrzeigersinn). */
  azimuthDeg: number;
  /** Höhe über dem Horizont in Grad. */
  elevationDeg: number;
  /** Schrägentfernung in Kilometern. */
  rangeKm: number;
  /** Punkt unter dem Satelliten. */
  subLat: number;
  subLon: number;
  /** Höhe über dem Ellipsoid in Kilometern. */
  altitudeKm: number;
}

const FLATTENING = 1 / 298.26;

/** Wo steht der Satellit von einem Ort aus gesehen? */
export function lookAngles(
  eci: Eci,
  ms: number,
  observer: { lat: number; lon: number; altKm?: number },
): LookAngle {
  const theta = gmst(ms);
  // TEME → erdfest: um die Sternzeit zurückdrehen.
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const x = eci.x * cosT + eci.y * sinT;
  const y = -eci.x * sinT + eci.y * cosT;
  const z = eci.z;

  const r = Math.hypot(x, y, z);
  const subLon = (((Math.atan2(y, x) / DEG + 540) % 360) - 180);
  const subLat = Math.asin(z / r) / DEG;
  const altitudeKm = r - EARTH_RADIUS_KM;

  // Beobachter im erdfesten System (Ellipsoid berücksichtigt).
  const latR = observer.lat * DEG;
  const lonR = observer.lon * DEG;
  const c = 1 / Math.sqrt(1 + FLATTENING * (FLATTENING - 2) * Math.sin(latR) ** 2);
  const sq = (1 - FLATTENING) ** 2 * c;
  const alt = observer.altKm ?? 0;
  const ox = (EARTH_RADIUS_KM * c + alt) * Math.cos(latR) * Math.cos(lonR);
  const oy = (EARTH_RADIUS_KM * c + alt) * Math.cos(latR) * Math.sin(lonR);
  const oz = (EARTH_RADIUS_KM * sq + alt) * Math.sin(latR);

  const rx = x - ox;
  const ry = y - oy;
  const rz = z - oz;

  // In das Horizontsystem des Beobachters drehen (Süd, Ost, Zenit).
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinLon = Math.sin(lonR);
  const cosLon = Math.cos(lonR);
  const south = sinLat * cosLon * rx + sinLat * sinLon * ry - cosLat * rz;
  const east = -sinLon * rx + cosLon * ry;
  const up = cosLat * cosLon * rx + cosLat * sinLon * ry + sinLat * rz;

  const rangeKm = Math.hypot(south, east, up);
  const elevationDeg = Math.asin(up / rangeKm) / DEG;
  const azimuthDeg = (Math.atan2(-east, south) / DEG + 180 + 360) % 360;

  return { azimuthDeg, elevationDeg, rangeKm, subLat, subLon, altitudeKm };
}

/** Bequemer Weg: Bahn + Zeitpunkt → Blickwinkel. */
export function observe(
  sat: Satrec,
  ms: number,
  observer: { lat: number; lon: number; altKm?: number },
): LookAngle | null {
  const eci = propagate(sat, (ms - sat.epochMs) / 60000);
  return eci ? lookAngles(eci, ms, observer) : null;
}
