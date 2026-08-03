/**
 * Schloss vor der App.
 *
 * **Der entscheidende Satz:** Ob die App entsperrt ist, entscheidet ein
 * *lokaler* Merker — nicht eine Anfrage an den Server. Sonst stünde man
 * unterwegs ohne Netz vor einem Passwortfeld, obwohl alle Daten längst im
 * Gerät liegen. Ein Netzfehler ändert nie etwas; nur eine **echte Antwort mit
 * 401** sperrt wieder zu.
 */

import { useCallback, useEffect, useState } from 'react';

const KEY = 'lagebild.unlocked';

/** Ist dieses Gerät schon einmal entsperrt worden? */
export function isUnlocked(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function setUnlocked(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* Speicher nicht verfügbar — dann eben je Sitzung */
  }
}

/**
 * Alle Abrufe hängen an `getJson` in api.ts. Meldet der Server dort ein 401,
 * ruft es hier an, und die App zeigt das Schloss.
 */
const listeners = new Set<() => void>();
export function reportUnauthorized(): void {
  setUnlocked(false);
  for (const notify of listeners) notify();
}

export interface AuthState {
  /** Darf die App losarbeiten? */
  unlocked: boolean;
  /** Verlangt der Server überhaupt ein Passwort? (null = noch unbekannt) */
  required: boolean | null;
  unlock: (password: string) => Promise<string | null>;
  lock: () => Promise<void>;
}

export function useAuth(): AuthState {
  const [unlocked, setState] = useState(() => isUnlocked());
  const [required, setRequired] = useState<boolean | null>(null);

  // Auf ein 401 aus irgendeinem Abruf hören.
  useEffect(() => {
    const notify = () => setState(false);
    listeners.add(notify);
    return () => {
      listeners.delete(notify);
    };
  }, []);

  // Einmal beim Start nachfragen. Antwortet der Server nicht, bleibt alles wie
  // es ist — genau darum geht es hier.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/auth/status', { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { required?: boolean; ok?: boolean } | null) => {
        if (cancelled || !data) return;
        setRequired(!!data.required);
        // Verlangt der Server nichts, ist die App immer offen.
        if (!data.required) {
          setUnlocked(true);
          setState(true);
        } else if (data.ok) {
          // Das Gerät hat ein gültiges Merkmal — Merker nachziehen, falls er
          // etwa nach dem Leeren des Speichers fehlt.
          setUnlocked(true);
          setState(true);
        } else if (isUnlocked()) {
          // Server erreichbar und sagt nein: das ist der einzige Fall, in dem
          // wieder zugesperrt wird.
          setUnlocked(false);
          setState(false);
        }
      })
      .catch(() => {
        /* kein Netz → nichts ändern */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const unlock = useCallback(async (password: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) return data?.error ?? 'Anmeldung fehlgeschlagen.';
      setUnlocked(true);
      setState(true);
      setRequired(true);
      return null;
    } catch {
      return 'Keine Verbindung zum Server. Zum Entsperren braucht es einmal Netz.';
    }
  }, []);

  const lock = useCallback(async () => {
    // Erst den Merker, dann den Server: Wer absperrt, soll das auch ohne Netz
    // durchbekommen.
    setUnlocked(false);
    setState(false);
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {
      /* ohne Netz bleibt das Merkmal im Browser, der Merker ist aber weg */
    });
  }, []);

  return { unlocked, required, unlock, lock };
}
