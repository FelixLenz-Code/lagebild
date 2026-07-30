import type { ApiEnvelope, WeatherNow, Coords } from '@lagebild/shared';

/** Standard-Standort, solange keine Geolocation vorliegt (Berlin-Mitte). */
export const DEFAULT_COORDS: Coords = { lat: 52.52, lon: 13.405 };

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

export function fetchWeather(coords: Coords): Promise<ApiEnvelope<WeatherNow>> {
  return getJson(`/api/weather?lat=${coords.lat}&lon=${coords.lon}`);
}
