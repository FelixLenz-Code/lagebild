/**
 * Bevölkerungsraster einer Region (Paketdatei `<code>.pop`).
 *
 * Beantwortet die Frage, die in jeder Lagemeldung steht: **Wie viele Menschen
 * sind betroffen?** — für eine gezeichnete Fläche, für einen Absperrkreis oder
 * für die Fahne eines Gefahrstoffaustritts.
 *
 * Die Zahlen stammen aus dem Zensus 2022 (Statistisches Bundesamt) und liegen
 * im amtlichen 100-Meter-Gitter in EPSG:3035. Diese Projektion ist
 * **flächentreu**, deshalb wird in ihr gerechnet: Die Abfragegeometrie wird
 * hineingerechnet, nicht das Gitter heraus.
 *
 * **Was die Zahl ist und was nicht:** Gezählt werden Menschen an ihrem
 * **Wohnort**, Stand Mai 2022. Wer tagsüber im Gewerbegebiet arbeitet, steht
 * nachts in seiner Wohnung — die Zahl ist also eine Nachtbelegung. Schulen,
 * Kliniken, Bahnhöfe und Veranstaltungen tauchen darin nicht auf. Das sagt die
 * Oberfläche mit.
 */

import type { Container } from './container.js';
import { toLaea } from './laea.js';

export interface PopulationMeta {
  code: string;
  crs: string;
  /** Kantenlänge einer Zelle in Metern. */
  cell: number;
  /** Linke untere Ecke des Rasters in EPSG:3035. */
  x0: number;
  y0: number;
  width: number;
  height: number;
  /** Einwohner im ganzen Paket (zur Anzeige). */
  people: number;
  bbox: [number, number, number, number];
  source: string;
}

export interface PopulationResult {
  /** Geschätzte Einwohnerzahl in der Fläche. */
  people: number;
  /** Wie viele bewohnte Zellen dazu beigetragen haben. */
  cells: number;
  /** Fläche der Abfrage in Quadratkilometern. */
  areaKm2: number;
  /**
   * Lag die Abfrage vollständig im Raster? Sonst ist die Zahl eine Untergrenze
   * — dann fehlt der Teil, der über den Rand des Pakets hinausragt.
   */
  covered: boolean;
}

export class Population {
  readonly meta: PopulationMeta;
  private grid: Uint16Array;

  constructor(container: Container) {
    this.meta = container.meta as unknown as PopulationMeta;
    this.grid = container.section('pop') as Uint16Array;
  }

  /** Deckt dieses Paket den Punkt ab? */
  covers(lat: number, lon: number): boolean {
    const [x, y] = toLaea(lat, lon);
    const { x0, y0, cell, width, height } = this.meta;
    return x >= x0 && y >= y0 && x < x0 + width * cell && y < y0 + height * cell;
  }

  /**
   * Summe über alle Zellen, deren **Mittelpunkt** in der Fläche liegt.
   *
   * Der Mittelpunkt ist die übliche Regel für Rasterstatistik: Sie ist
   * eindeutig, schnell, und der Fehler an den Rändern hebt sich über den Umfang
   * hinweg weitgehend auf. Eine anteilige Verrechnung angeschnittener Zellen
   * würde eine Genauigkeit vortäuschen, die die Quelle nicht hat — der Zensus
   * verschiebt kleine Zellwerte selbst zum Schutz der Einzelangaben.
   */
  private sum(
    test: (x: number, y: number) => boolean,
    box: { x0: number; y0: number; x1: number; y1: number },
  ): { people: number; cells: number; covered: boolean } {
    const { cell, width, height } = this.meta;
    const ox = this.meta.x0;
    const oy = this.meta.y0;

    const cx0 = Math.floor((box.x0 - ox) / cell);
    const cx1 = Math.ceil((box.x1 - ox) / cell);
    // Zeile 0 liegt im Norden.
    const cy0 = Math.floor((oy + height * cell - box.y1) / cell);
    const cy1 = Math.ceil((oy + height * cell - box.y0) / cell);
    const covered = cx0 >= 0 && cy0 >= 0 && cx1 <= width && cy1 <= height;

    let people = 0;
    let cells = 0;
    for (let cy = Math.max(0, cy0); cy < Math.min(height, cy1); cy++) {
      const y = oy + (height - cy - 0.5) * cell;
      for (let cx = Math.max(0, cx0); cx < Math.min(width, cx1); cx++) {
        const value = this.grid[cy * width + cx]!;
        if (!value) continue;
        const x = ox + (cx + 0.5) * cell;
        if (!test(x, y)) continue;
        people += value;
        cells++;
      }
    }
    return { people, cells, covered };
  }

  /** Einwohner in einem Kreis um einen Punkt. */
  inCircle(center: { lat: number; lon: number }, radiusM: number): PopulationResult {
    const [x0, y0] = toLaea(center.lat, center.lon);
    const r2 = radiusM * radiusM;
    const { people, cells, covered } = this.sum(
      (x, y) => (x - x0) * (x - x0) + (y - y0) * (y - y0) <= r2,
      { x0: x0 - radiusM, y0: y0 - radiusM, x1: x0 + radiusM, y1: y0 + radiusM },
    );
    return { people, cells, areaKm2: (Math.PI * r2) / 1e6, covered };
  }

  /**
   * Einwohner in einer Fläche ([lon, lat], nur der äußere Ring).
   *
   * Der Punkt-in-Fläche-Test läuft im projizierten Raum: Die Ringpunkte werden
   * einmal umgerechnet, danach ist es ebene Geometrie. Über den Umweg „jede
   * Zelle nach Grad zurückrechnen" wären es Millionen Umrechnungen statt einiger
   * Dutzend.
   */
  inPolygon(ring: [number, number][]): PopulationResult {
    if (ring.length < 3) return { people: 0, cells: 0, areaKm2: 0, covered: true };
    const pts = ring.map(([lon, lat]) => toLaea(lat, lon));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }

    // Strahlverfahren, wie in places.ts — hier nur in Metern statt in Grad.
    const inside = (px: number, py: number): boolean => {
      let hit = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [xi, yi] = pts[i]!;
        const [xj, yj] = pts[j]!;
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };

    const { people, cells, covered } = this.sum(inside, { x0, y0, x1, y1 });

    // Fläche über die Gaußsche Trapezformel — in LAEA ist sie echt, das ist der
    // Sinn dieser Projektion.
    let area2 = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      area2 += (pts[j]![0] + pts[i]![0]) * (pts[j]![1] - pts[i]![1]);
    }
    return { people, cells, areaKm2: Math.abs(area2 / 2) / 1e6, covered };
  }

  /**
   * Einwohner in einem Kreissektor — für die Fahne stromab eines
   * Gefahrstoffaustritts. `fromDeg` ist die Richtung, **in** die es zieht.
   */
  inSector(
    center: { lat: number; lon: number },
    radiusM: number,
    towardDeg: number,
    halfAngleDeg: number,
  ): PopulationResult {
    const [x0, y0] = toLaea(center.lat, center.lon);
    // In LAEA zeigt „oben" nicht überall exakt nach Norden; über die wenigen
    // Kilometer einer Fahne ist die Meridiankonvergenz aber kleiner als die
    // Unsicherheit der Windrichtung selbst.
    const r2 = radiusM * radiusM;
    const dir = ((90 - towardDeg) * Math.PI) / 180;
    const half = (halfAngleDeg * Math.PI) / 180;
    const { people, cells, covered } = this.sum(
      (x, y) => {
        const dx = x - x0;
        const dy = y - y0;
        if (dx * dx + dy * dy > r2) return false;
        let d = Math.atan2(dy, dx) - dir;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return Math.abs(d) <= half;
      },
      { x0: x0 - radiusM, y0: y0 - radiusM, x1: x0 + radiusM, y1: y0 + radiusM },
    );
    return { people, cells, areaKm2: (half * r2) / 1e6, covered };
  }
}
