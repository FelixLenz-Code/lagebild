/**
 * Lambert-Azimutal flächentreu (ETRS89-LAEA, EPSG:3035) — hin und zurück.
 *
 * Das ist die Projektion, in der die amtlichen europäischen Gitter liegen, auch
 * das Bevölkerungsgitter des Zensus. **Flächentreu** heißt: Eine Zelle von
 * 100 m × 100 m ist überall in Europa gleich groß — genau deshalb wird darin
 * gezählt und nicht in Web Mercator, wo eine Zelle in Flensburg deutlich mehr
 * Fläche bedeckt als eine in München.
 *
 * Die Formeln stehen so in Snyder, *Map Projections — A Working Manual*
 * (US Geological Survey, 1987), Kapitel 24 (ellipsoidischer Fall). Eine
 * Bibliothek dafür wäre die zwölfte Abhängigkeit für dreißig Zeilen Rechnung.
 *
 * Dieselbe Rechnung liegt als TypeScript in `apps/web/src/offline/laea.ts` —
 * beide Fassungen werden vom Prüfskript gegeneinander und gegen amtliche
 * Stützpunkte gehalten.
 */

/** GRS80 (identisch mit WGS84 im hier nötigen Genauigkeitsbereich). */
const A = 6378137.0;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const E = Math.sqrt(E2);

/** Bezugspunkt von EPSG:3035. */
const LAT0 = (52 * Math.PI) / 180;
const LON0 = (10 * Math.PI) / 180;
const FALSE_EASTING = 4321000;
const FALSE_NORTHING = 3210000;

const RAD = Math.PI / 180;

/** Authalische Breite („gleiche Fläche") — der Kern des Verfahrens. */
function qOf(sinPhi) {
  const es = E * sinPhi;
  return (
    (1 - E2) *
    (sinPhi / (1 - es * es) - (1 / (2 * E)) * Math.log((1 - es) / (1 + es)))
  );
}

const Q_P = qOf(1);
const R_Q = A * Math.sqrt(Q_P / 2);

/** Authalische Breite aus q. */
const betaOf = (q) => Math.asin(q / Q_P);

const BETA0 = betaOf(qOf(Math.sin(LAT0)));
const D = (A * Math.cos(LAT0)) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2) / (R_Q * Math.cos(BETA0));

/** Grad → Meter in EPSG:3035. */
export function toLaea(lat, lon) {
  const phi = lat * RAD;
  const lam = lon * RAD - LON0;
  const beta = betaOf(qOf(Math.sin(phi)));
  const b =
    R_Q *
    Math.sqrt(
      2 / (1 + Math.sin(BETA0) * Math.sin(beta) + Math.cos(BETA0) * Math.cos(beta) * Math.cos(lam)),
    );
  const x = FALSE_EASTING + b * D * Math.cos(beta) * Math.sin(lam);
  const y =
    FALSE_NORTHING +
    (b / D) * (Math.cos(BETA0) * Math.sin(beta) - Math.sin(BETA0) * Math.cos(beta) * Math.cos(lam));
  return [x, y];
}

/** Meter in EPSG:3035 → Grad. */
export function fromLaea(x, y) {
  const px = x - FALSE_EASTING;
  const py = y - FALSE_NORTHING;
  const rho = Math.hypot(px / D, py * D);
  if (rho < 1e-9) return [LAT0 / RAD, LON0 / RAD];
  const ce = 2 * Math.asin(rho / (2 * R_Q));
  const cosCe = Math.cos(ce);
  const sinCe = Math.sin(ce);
  const beta = Math.asin(cosCe * Math.sin(BETA0) + ((py * D * sinCe * Math.cos(BETA0)) / rho));
  const lam =
    LON0 +
    Math.atan2(
      (px / D) * sinCe,
      rho * Math.cos(BETA0) * cosCe - py * D * Math.sin(BETA0) * sinCe,
    );

  // Von der authalischen Breite zurück auf die geodätische — die Reihe
  // konvergiert für die Erdabplattung in wenigen Gliedern.
  const q = Q_P * Math.sin(beta);
  let phi = Math.asin(q / 2);
  for (let i = 0; i < 12; i++) {
    const s = Math.sin(phi);
    const c = Math.cos(phi);
    const es = E * s;
    const t = 1 - es * es;
    const d =
      ((t * t) / (2 * c)) *
      (q / (1 - E2) - s / t + (1 / (2 * E)) * Math.log((1 - es) / (1 + es)));
    phi += d;
    if (Math.abs(d) < 1e-12) break;
  }
  return [phi / RAD, lam / RAD];
}
