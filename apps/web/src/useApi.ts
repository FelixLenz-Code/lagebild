import { useEffect, useState } from 'react';
import { withCache } from './cache.js';

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** true, wenn die aktuell gezeigten Daten offline aus dem Cache stammen. */
  fromCache: boolean;
  /** Zeitpunkt (ms) des letzten erfolgreichen Abrufs. */
  savedAt: number | null;
}

/**
 * Lädt eine Ressource offline-first: liefert live oder – bei Netzfehler –
 * den zuletzt gespeicherten Stand. Bereits vorhandene Daten bleiben während
 * eines Refreshs sichtbar (kein Flackern).
 */
export function useApi<T>(
  key: string,
  loader: () => Promise<T>,
  deps: unknown[] = [],
  opts: {
    /** `enabled: false` lädt (noch) nicht — für Daten, die erst auf Zuruf nötig sind. */
    enabled?: boolean;
    /** Wiederholt den Abruf in diesem Takt (ms) — für Live-Positionen. */
    refreshMs?: number;
    /** `cache: false` überspringt den Offline-Speicher (kurzlebige Daten). */
    cache?: boolean;
  } = {},
): ApiState<T> {
  const enabled = opts.enabled ?? true;
  const refreshMs = opts.refreshMs ?? 0;
  const useCache = opts.cache ?? true;
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    error: null,
    loading: true,
    fromCache: false,
    savedAt: null,
  });

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    let alive = true;
    const load = () => {
      const run = useCache
        ? withCache(key, loader)
        : loader().then((value) => ({ value, fromCache: false, savedAt: Date.now() }));
      run
        .then(({ value, fromCache, savedAt }) => {
          if (alive) setState({ data: value, error: null, loading: false, fromCache, savedAt });
        })
        .catch((e: unknown) => {
          if (alive)
            setState((s) => ({
              ...s,
              error: e instanceof Error ? e.message : 'Fehler',
              loading: false,
            }));
        });
    };

    setState((s) => ({ ...s, loading: true, error: null }));
    load();
    const timer = refreshMs > 0 ? setInterval(load, refreshMs) : undefined;
    return () => {
      alive = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, refreshMs, useCache]);

  return state;
}
