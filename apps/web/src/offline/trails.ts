/**
 * Wander- und Radwegenetz aus dem Routing-Paket.
 *
 * Die Zugehörigkeit steht als Bitmaske an jeder Kante (gesetzt beim Paketbau
 * aus den OSM-Relationen `type=route`), die Linien kommen aus derselben
 * Geometrie, auf der auch das Routing läuft — es liegt also nichts doppelt im
 * Gerät.
 */

/** Streckenarten, gleiche Werte wie im Paketbau. */
export const TRAIL = { HIKE: 1, BIKE: 2, MTB: 4 } as const;

export interface TrailFeature {
  coordinates: [number, number][];
  /** Bitmaske der Arten, zu denen die Kante gehört. */
  kind: number;
  /** Name der überregionalsten Route auf dieser Kante. */
  name: string | null;
}

export interface TrailResult {
  features: TrailFeature[];
  /** true, wenn das Paket noch ohne Wegenetz gebaut wurde. */
  stale: boolean;
}
