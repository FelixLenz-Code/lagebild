/**
 * Offline-Speicher im OPFS (Origin Private File System). Pro Bundesland gibt
 * es bis zu drei Pakete:
 *
 *   <code>.pmtiles   Hintergrundkarte (Vektorkacheln)
 *   <code>.route     Routing-Graph für die Navigation
 *   <code>.search    Suchindex mit Adressen und POIs
 *
 * Karten liegen so, wie sie kommen. Routing und Suche kommen deflate-gepackt
 * vom Server und werden hier einmalig entpackt abgelegt — dadurch bleibt der
 * Download klein, der Start schnell, und die Hausnummern lassen sich später
 * gezielt aus der Datei lesen.
 */

/** Basis-URL der herunterladbaren Pakete (Prod: eigener VPS-Host). */
export const MAPS_BASE: string = import.meta.env.VITE_MAPS_BASE ?? '/api/maps';

/** Die Bestandteile einer Offline-Region. */
export type PackageKind = 'map' | 'route' | 'search' | 'terrain';

export const PACKAGE_EXT: Record<PackageKind, string> = {
  map: 'pmtiles',
  route: 'route',
  search: 'search',
  terrain: 'terrain',
};

/** Diese Pakete liegen gepackt auf dem Server. */
const COMPRESSED: Record<PackageKind, boolean> = {
  map: false,
  route: true,
  search: true,
  terrain: true,
};

export const PACKAGE_LABEL: Record<PackageKind, string> = {
  map: 'Karte',
  route: 'Routing',
  search: 'Suche',
  terrain: 'Höhen',
};

/** Belegter Platz je Bestandteil, in Bytes. */
export type RegionFiles = Partial<Record<PackageKind, number>>;

export function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && 'getDirectory' in navigator.storage;
}

async function mapsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('maps', { create: true });
}

const fileName = (code: string, kind: PackageKind) => `${code}.${PACKAGE_EXT[kind]}`;

/** Heruntergeladene Regionen: code → { map, route, search } in Bytes. */
export async function listOffline(): Promise<Record<string, RegionFiles>> {
  const out: Record<string, RegionFiles> = {};
  if (!opfsSupported()) return out;
  const dir = await mapsDir();
  // entries() ist auf OPFS-Verzeichnissen ein AsyncIterator (Typen unvollständig).
  const iter = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
  for await (const [name, handle] of iter) {
    if (handle.kind !== 'file') continue;
    const m = name.match(/^(\d{2})\.(pmtiles|route|search|terrain)$/);
    if (!m) continue;
    const kind = (Object.keys(PACKAGE_EXT) as PackageKind[]).find((k) => PACKAGE_EXT[k] === m[2]);
    if (!kind) continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    (out[m[1]!] ??= {})[kind] = file.size;
  }
  return out;
}

/** Reine Größe eines Bestandteils, oder 0. */
export const regionBytes = (files: RegionFiles | undefined): number =>
  files ? Object.values(files).reduce((a, b) => a + (b ?? 0), 0) : 0;

/**
 * Lädt ein Paket in den OPFS. `onProgress` bekommt den Anteil der übertragenen
 * (also gepackten) Bytes — das ist das, was der Nutzer wartet.
 */
export async function downloadPackage(
  code: string,
  kind: PackageKind,
  onProgress: (fraction: number, bytes: number) => void,
): Promise<void> {
  const res = await fetch(`${MAPS_BASE}/${fileName(code, kind)}`);
  if (!res.ok || !res.body) throw new Error(`Download fehlgeschlagen (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;

  const dir = await mapsDir();
  const handle = await dir.getFileHandle(fileName(code, kind), { create: true });
  const writable = await handle.createWritable();
  const reader = res.body.getReader();
  let received = 0;
  const report = (extra = 0) => {
    received += extra;
    onProgress(total ? received / total : 0, received);
  };

  try {
    if (!COMPRESSED[kind]) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        report(value.byteLength);
      }
    } else {
      await writeUnpacked(reader, writable, report);
    }
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => {});
    await deletePackage(code, kind).catch(() => {});
    throw err;
  }
}

/**
 * Schreibt ein gepacktes Paket entpackt in den OPFS: Kopf unverändert
 * übernehmen (nur das Flag `deflate` umsetzen), Rest durch DecompressionStream.
 */
async function writeUnpacked(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writable: FileSystemWritableFileStream,
  report: (bytes: number) => void,
): Promise<void> {
  // Kopf einsammeln: Magie (6) + Version (2) + Kopflänge (4) + JSON.
  let head = new Uint8Array(0);
  const append = (chunk: Uint8Array) => {
    const next = new Uint8Array(head.length + chunk.length);
    next.set(head);
    next.set(chunk, head.length);
    head = next;
  };
  let headerLen = -1;
  for (;;) {
    if (head.length >= 12) {
      headerLen = new DataView(head.buffer, head.byteOffset).getUint32(8, true);
      if (head.length >= 12 + headerLen) break;
    }
    const { done, value } = await reader.read();
    if (done) throw new Error('Paket unvollständig');
    report(value.byteLength);
    append(value);
  }

  const meta = JSON.parse(new TextDecoder().decode(head.subarray(12, 12 + headerLen))) as Record<
    string,
    unknown
  >;
  meta.deflate = false;
  // Wie beim Bauen: mit Leerzeichen auffüllen, damit die Nutzlast an einer
  // 4-Byte-Grenze beginnt (sonst sind keine TypedArray-Sichten möglich).
  let json = JSON.stringify(meta);
  while ((12 + new TextEncoder().encode(json).length) % 4 !== 0) json += ' ';
  const newHeader = new TextEncoder().encode(json);
  const prefix = new Uint8Array(12 + newHeader.length);
  prefix.set(head.subarray(0, 12));
  new DataView(prefix.buffer).setUint32(8, newHeader.length, true);
  prefix.set(newHeader, 12);
  await writable.write(prefix);

  const leftover = head.subarray(12 + headerLen);
  const packed = new ReadableStream<Uint8Array>({
    start(controller) {
      if (leftover.length) controller.enqueue(leftover);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else {
        report(value.byteLength);
        controller.enqueue(value);
      }
    },
  });

  // Die TypeScript-Typen der Streams-API sind hier je nach lib-Version anders
  // generisch — der Datenfluss selbst ist unverändert.
  const plain = (packed as ReadableStream<Uint8Array>)
    .pipeThrough(new DecompressionStream('deflate-raw') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    .getReader();
  for (;;) {
    const { done, value } = await plain.read();
    if (done) break;
    await writable.write(value as unknown as BufferSource);
  }
}

export async function deletePackage(code: string, kind: PackageKind): Promise<void> {
  if (!opfsSupported()) return;
  const dir = await mapsDir();
  await dir.removeEntry(fileName(code, kind)).catch(() => {});
}

/** Löscht alle Bestandteile einer Region. */
export async function deleteRegion(code: string): Promise<void> {
  for (const kind of Object.keys(PACKAGE_EXT) as PackageKind[]) await deletePackage(code, kind);
}

/** Ein gespeichertes Paket als File (PMTiles-Protokoll, Graph, Suchindex). */
export async function getOfflineFile(code: string, kind: PackageKind = 'map'): Promise<File> {
  const dir = await mapsDir();
  const handle = await dir.getFileHandle(fileName(code, kind));
  return handle.getFile();
}
