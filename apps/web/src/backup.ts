/**
 * Alles sichern und zurückholen.
 *
 * Sämtliche eigenen Daten dieser App liegen im **localStorage eines
 * Browsers** — Markierungen, Spuren, beobachtete Orte, gespeicherte Ziele,
 * Karten für die Diashow, Rufzeichen, Einstellungen. Ohne diese Datei überlebt
 * nichts davon einen Gerätewechsel, ein geleertes Browserprofil oder eine
 * neu installierte App.
 *
 * Bewusst **nicht** mitgesichert: der Zwischenspeicher der Fachdaten (der ist
 * in Minuten wieder da) und die Offline-Pakete (hunderte Megabyte, jederzeit
 * neu ladbar).
 */

/** Was gesichert wird — Schlüssel im localStorage mit Klarnamen. */
export const BACKUP_KEYS: { key: string; label: string }[] = [
  { key: 'lagebild.draw', label: 'Markierungen' },
  { key: 'lagebild.tracks', label: 'Spuren' },
  { key: 'lagebild.watched', label: 'Beobachtete Orte' },
  { key: 'lagebild.favorites', label: 'Gespeicherte Ziele' },
  { key: 'lagebild.presets', label: 'Karten und Diashow' },
  { key: 'lagebild.aprs', label: 'Rufzeichen' },
  { key: 'lagebild.settings', label: 'Einstellungen' },
];

const MAGIC = 'lagebild-sicherung';
const VERSION = 1;

export interface BackupFile {
  format: typeof MAGIC;
  version: number;
  createdAt: string;
  data: Record<string, unknown>;
}

/** Was steckt gerade drin? Zahl der Einträge je Bereich, für die Anzeige. */
export function backupSummary(): { label: string; count: number }[] {
  return BACKUP_KEYS.map(({ key, label }) => {
    let count = 0;
    try {
      const raw = localStorage.getItem(key);
      const value = raw ? JSON.parse(raw) : null;
      if (Array.isArray(value)) count = value.length;
      else if (value && typeof value === 'object') count = Object.keys(value).length;
      else if (value != null) count = 1;
    } catch {
      count = 0;
    }
    return { label, count };
  });
}

export function makeBackup(): BackupFile {
  const data: Record<string, unknown> = {};
  for (const { key } of BACKUP_KEYS) {
    const raw = localStorage.getItem(key);
    if (raw == null) continue;
    try {
      data[key] = JSON.parse(raw);
    } catch {
      // Unlesbares wird als Zeichenkette mitgenommen, statt es zu verlieren.
      data[key] = raw;
    }
  }
  return { format: MAGIC, version: VERSION, createdAt: new Date().toISOString(), data };
}

export class BackupError extends Error {}

/**
 * Sicherung einspielen. `mode: 'replace'` ersetzt alles, `'merge'` hängt
 * Listeneinträge an, die es noch nicht gibt (nach `id`, sonst nach Inhalt).
 * Zurück kommt, was je Bereich dazukam.
 */
export function restoreBackup(text: string, mode: 'replace' | 'merge'): Record<string, number> {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    throw new BackupError('Das ist keine gültige Sicherungsdatei.');
  }
  if (file?.format !== MAGIC || !file.data) {
    throw new BackupError('Diese Datei stammt nicht aus dieser App.');
  }
  if (file.version > VERSION) {
    throw new BackupError('Die Sicherung stammt aus einer neueren Fassung der App.');
  }

  const added: Record<string, number> = {};
  for (const { key, label } of BACKUP_KEYS) {
    const incoming = file.data[key];
    if (incoming === undefined) continue;

    if (mode === 'replace' || !Array.isArray(incoming)) {
      localStorage.setItem(key, JSON.stringify(incoming));
      added[label] = Array.isArray(incoming) ? incoming.length : 1;
      continue;
    }

    // Zusammenführen: vorhandene Einträge bleiben, neue kommen dazu.
    let current: unknown[] = [];
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) current = parsed;
    } catch {
      current = [];
    }
    const known = new Set(
      current.map((e) => (e && typeof e === 'object' && 'id' in e ? String((e as { id: unknown }).id) : JSON.stringify(e))),
    );
    let count = 0;
    for (const entry of incoming as unknown[]) {
      const id = entry && typeof entry === 'object' && 'id' in entry ? String((entry as { id: unknown }).id) : JSON.stringify(entry);
      if (known.has(id)) continue;
      known.add(id);
      current.push(entry);
      count++;
    }
    localStorage.setItem(key, JSON.stringify(current));
    added[label] = count;
  }
  return added;
}

/** Belegter Platz und Gesamtkontingent des Browsers, wenn er es verrät. */
export async function storageEstimate(): Promise<{ usedBytes: number; quotaBytes: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const e = await navigator.storage.estimate();
  return { usedBytes: e.usage ?? 0, quotaBytes: e.quota ?? 0 };
}

export interface BatteryState {
  level: number;
  charging: boolean;
}

/**
 * Akkustand, wo der Browser ihn hergibt (Chrome/Android; Firefox und Safari
 * nicht). Fehlt er, wird die Zeile weggelassen statt geraten.
 */
export async function batteryState(): Promise<BatteryState | null> {
  const get = (navigator as { getBattery?: () => Promise<{ level: number; charging: boolean }> }).getBattery;
  if (typeof get !== 'function') return null;
  try {
    const b = await get.call(navigator);
    return { level: b.level, charging: b.charging };
  } catch {
    return null;
  }
}
