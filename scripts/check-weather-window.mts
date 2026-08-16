/**
 * Prüflauf für den Wetterfenster-Finder:
 *
 *   apps/api/node_modules/.bin/tsx scripts/check-weather-window.mts
 *
 * `findWindows` rechnet nur mit Zahlen und dem Sonnenstand — kein DOM, kein
 * Netz — und läuft deshalb hier unverändert. Geprüft wird an einer von Hand
 * gesetzten Vorhersage, dass die Fenster an den richtigen Stunden anfangen und
 * aufhören, dass jede Bedingung für sich greift und dass der Grund stimmt,
 * wenn gar nichts passt.
 */

import { DEFAULT_CRITERIA, findWindows, type WindowCriteria } from '../apps/web/src/weatherWindow.js';
import type { WeatherForecastStep } from '../packages/shared/src/index.js';

let failed = 0;
function check(what: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FEHL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed++;
}

/** Bremen, damit der Sonnenstand einen realistischen Tag ergibt. */
const COORDS = { lat: 53.08, lon: 8.8 };

/** Ein Sommertag, damit „Tageslicht" nicht vom Zufall abhängt. */
const DAY = '2026-06-15';
const at = (hour: number) => `${DAY}T${String(hour).padStart(2, '0')}:00:00+02:00`;
const START = new Date(at(6));

function hour(h: number, over: Partial<WeatherForecastStep> = {}): WeatherForecastStep {
  return {
    time: at(h),
    tempC: 18,
    condition: 'dry',
    icon: 'clear-day',
    precipitationProbabilityPct: 0,
    precipitationMm: 0,
    windKmh: 10,
    windGustKmh: 15,
    ...over,
  };
}

/* Ein Tag mit Regen von 10 bis 12 Uhr. */
const REGENTAG: WeatherForecastStep[] = [];
for (let h = 6; h <= 20; h++) {
  REGENTAG.push(h >= 10 && h <= 12 ? hour(h, { precipitationMm: 1.4, condition: 'rain' }) : hour(h));
}

const basis = findWindows(REGENTAG, COORDS, DEFAULT_CRITERIA, 2, START);
check('zwei Fenster um den Regen herum', basis.windows.length === 2, `${basis.windows.length}`);
check('erstes Fenster 6–9 Uhr', basis.windows[0]?.start === at(6) && basis.windows[0]?.end === at(9), `${basis.windows[0]?.start} … ${basis.windows[0]?.end}`);
check('zweites Fenster beginnt 13 Uhr', basis.windows[1]?.start === at(13));
check('Länge zählt die Endstunde mit', basis.windows[0]?.hours === 4, `${basis.windows[0]?.hours} h`);

/* Mindestlänge schneidet kurze Fenster weg. */
const lang = findWindows(REGENTAG, COORDS, DEFAULT_CRITERIA, 6, START);
check('mit Mindestlänge 6 h bleibt nur das Nachmittagsfenster', lang.windows.length === 1 && lang.windows[0]?.start === at(13));

/* Wind allein muss ein Fenster verhindern können. */
const WINDIG = REGENTAG.map((s) => ({ ...s, windGustKmh: 65 }));
const wind = findWindows(WINDIG, COORDS, DEFAULT_CRITERIA, 2, START);
check('Böen sperren alle Stunden', wind.windows.length === 0);
check('Grund ist der Wind', wind.reasons.wind > 0 && wind.reasons.rain === 3, JSON.stringify(wind.reasons));

/* Böen zählen auch dann, wenn der Mittelwind harmlos ist. */
const nurBoeen = findWindows(
  REGENTAG.map((s) => ({ ...s, windKmh: 8, windGustKmh: 55 })),
  COORDS,
  { ...DEFAULT_CRITERIA, maxWindKmh: 40 },
  2,
  START,
);
check('Böe schlägt Mittelwind', nurBoeen.windows.length === 0);

/* Temperaturgrenzen. */
const kalt: WindowCriteria = { ...DEFAULT_CRITERIA, minTempC: 20 };
const kaltRes = findWindows(REGENTAG, COORDS, kalt, 2, START);
check('zu kalt sperrt', kaltRes.windows.length === 0 && kaltRes.reasons.cold > 0);

/* Tageslicht: nachts darf nichts gefunden werden. */
const NACHT: WeatherForecastStep[] = [];
for (let h = 0; h <= 3; h++) NACHT.push(hour(h));
const nacht = findWindows(NACHT, COORDS, DEFAULT_CRITERIA, 2, new Date(at(0)));
check('nachts kein Fenster bei „nur Tageslicht"', nacht.windows.length === 0 && nacht.reasons.dark === 4);
const nachtOhne = findWindows(NACHT, COORDS, { ...DEFAULT_CRITERIA, daylightOnly: false }, 2, new Date(at(0)));
check('ohne die Bedingung schon', nachtOhne.windows.length === 1 && nachtOhne.windows[0]?.hours === 4);

/* Vergangene Stunden zählen nicht mehr mit. */
const spaet = findWindows(REGENTAG, COORDS, DEFAULT_CRITERIA, 2, new Date(at(15)));
check('Stunden vor jetzt fallen weg', spaet.windows.length === 1 && spaet.windows[0]!.start === at(14), `${spaet.windows[0]?.start}`);

/* Kennwerte im Fenster. */
const kennwerte = findWindows(
  [hour(9, { tempC: 21, windGustKmh: 28, precipitationProbabilityPct: 20 }), hour(10, { tempC: 24, windGustKmh: 19 })],
  COORDS,
  DEFAULT_CRITERIA,
  2,
  START,
);
const w = kennwerte.windows[0];
check('Höchstwerte im Fenster', w?.maxTempC === 24 && w?.maxWindKmh === 28 && w?.maxRainProbPct === 20, JSON.stringify(w));

console.log(failed ? `\n${failed} Prüfung(en) fehlgeschlagen` : '\nalle Prüfungen bestanden');
process.exit(failed ? 1 : 0);
