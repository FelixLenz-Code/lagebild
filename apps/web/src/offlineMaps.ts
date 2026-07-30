/**
 * Offline-Kartenspeicher im OPFS (Origin Private File System): lädt PMTiles pro
 * Bundesland herunter, listet und löscht sie. Dateiname = <code>.pmtiles.
 */

/** Basis-URL der herunterladbaren PMTiles (Prod: eigener VPS-Host). */
export const MAPS_BASE: string = import.meta.env.VITE_MAPS_BASE ?? '/api/maps';

export function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && 'getDirectory' in navigator.storage;
}

async function mapsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('maps', { create: true });
}

/** Heruntergeladene Regionen als code → Bytegröße. */
export async function listOffline(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (!opfsSupported()) return out;
  const dir = await mapsDir();
  // entries() ist auf OPFS-Verzeichnissen ein AsyncIterator (Typen unvollständig).
  const iter = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, handle] of iter) {
    if (handle.kind === 'file' && name.endsWith('.pmtiles')) {
      const file = await (handle as FileSystemFileHandle).getFile();
      out[name.replace('.pmtiles', '')] = file.size;
    }
  }
  return out;
}

/** Lädt eine Region in den OPFS, mit Fortschritts-Callback (0..1). */
export async function downloadOffline(
  code: string,
  onProgress: (fraction: number, bytes: number) => void,
): Promise<void> {
  const res = await fetch(`${MAPS_BASE}/${code}.pmtiles`);
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;

  const dir = await mapsDir();
  const handle = await dir.getFileHandle(`${code}.pmtiles`, { create: true });
  const writable = await handle.createWritable();
  const reader = res.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await writable.write(value);
      received += value.byteLength;
      onProgress(total ? received / total : 0, received);
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    await deleteOffline(code).catch(() => {});
    throw err;
  }
}

export async function deleteOffline(code: string): Promise<void> {
  if (!opfsSupported()) return;
  const dir = await mapsDir();
  await dir.removeEntry(`${code}.pmtiles`).catch(() => {});
}

/** Die gespeicherte PMTiles-Datei als File (für das pmtiles://-Protokoll). */
export async function getOfflineFile(code: string): Promise<File> {
  const dir = await mapsDir();
  const handle = await dir.getFileHandle(`${code}.pmtiles`);
  return handle.getFile();
}
