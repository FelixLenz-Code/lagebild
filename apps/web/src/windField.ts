import type { Map as MlMap } from 'maplibre-gl';
import type { WindField, WindPoint } from '@lagebild/shared';

/**
 * Strömungsbild des Windes: viele kleine Teilchen treiben mit dem Wind und
 * ziehen dabei kurze, verblassende Spuren. Das Feld selbst besteht nur aus
 * wenigen Gitterpunkten — zwischen ihnen wird bilinear interpoliert, sodass
 * ein durchgehendes Bild entsteht.
 *
 * Gezeichnet wird auf ein eigenes Canvas über der Karte; die Teilchen leben in
 * Bildschirmkoordinaten und fragen ihre Geschwindigkeit an der jeweils
 * darunterliegenden Position ab.
 */

/** Windvektor in km/h: `u` nach Osten, `v` nach Norden. */
export interface WindVector {
  u: number;
  v: number;
  speed: number;
}

/** Regelmäßiges Gitter mit bilinearer Interpolation. */
export class WindGrid {
  private readonly points: WindPoint[];
  private readonly cols: number;
  private readonly rows: number;
  private readonly lat0: number;
  private readonly lon0: number;
  private readonly dLat: number;
  private readonly dLon: number;

  constructor(field: WindField) {
    this.points = field.points;
    this.cols = field.cols;
    this.rows = field.rows;
    const first = field.points[0]?.coordinates ?? { lat: 0, lon: 0 };
    this.lat0 = first.lat;
    this.lon0 = first.lon;
    this.dLat = (field.points[field.cols]?.coordinates.lat ?? first.lat + 1) - first.lat;
    this.dLon = (field.points[1]?.coordinates.lon ?? first.lon + 1) - first.lon;
  }

  get valid(): boolean {
    return this.points.length >= this.cols * this.rows && this.dLat !== 0 && this.dLon !== 0;
  }

  private vectorAt(col: number, row: number): WindVector {
    const c = Math.min(Math.max(col, 0), this.cols - 1);
    const r = Math.min(Math.max(row, 0), this.rows - 1);
    const p = this.points[r * this.cols + c]!;
    // Meldeschema: Richtung, aus der der Wind weht → Bewegungsrichtung + 180°.
    const rad = ((p.directionDeg + 180) * Math.PI) / 180;
    return { u: p.speedKmh * Math.sin(rad), v: p.speedKmh * Math.cos(rad), speed: p.speedKmh };
  }

  /** Wind an beliebiger Stelle; außerhalb des Gitters gilt der Randwert. */
  sample(lat: number, lon: number): WindVector {
    const x = (lon - this.lon0) / this.dLon;
    const y = (lat - this.lat0) / this.dLat;
    const c0 = Math.floor(x);
    const r0 = Math.floor(y);
    const fx = Math.min(Math.max(x - c0, 0), 1);
    const fy = Math.min(Math.max(y - r0, 0), 1);

    const a = this.vectorAt(c0, r0);
    const b = this.vectorAt(c0 + 1, r0);
    const c = this.vectorAt(c0, r0 + 1);
    const d = this.vectorAt(c0 + 1, r0 + 1);
    const mix = (p: number, q: number, s: number, t: number) =>
      (p * (1 - fx) + q * fx) * (1 - fy) + (s * (1 - fx) + t * fx) * fy;

    const u = mix(a.u, b.u, c.u, d.u);
    const v = mix(a.v, b.v, c.v, d.v);
    return { u, v, speed: Math.hypot(u, v) };
  }

  /**
   * Böe an einer Stelle (km/h) — nächster Gitterpunkt, ohne Interpolation.
   *
   * Böen sind Spitzenwerte; sie zwischen vier Punkten zu mitteln würde genau
   * das wegrechnen, worauf es ankommt. Meldet das Modell keine Böe, bleibt die
   * mittlere Geschwindigkeit als untere Schranke.
   */
  gustAt(lat: number, lon: number): number {
    const c = Math.min(Math.max(Math.round((lon - this.lon0) / this.dLon), 0), this.cols - 1);
    const r = Math.min(Math.max(Math.round((lat - this.lat0) / this.dLat), 0), this.rows - 1);
    const p = this.points[r * this.cols + c];
    if (!p) return 0;
    return Math.max(p.gustKmh ?? 0, p.speedKmh);
  }
}

interface Particle {
  x: number;
  y: number;
  age: number;
  life: number;
}

/** Wie viele Bildschirmpixel pro Bild ein Wind von 1 km/h zurücklegt. */
const PX_PER_KMH = 0.07;
/** Teilchen je Megapixel Kartenfläche. */
const DENSITY = 1900;
const MIN_PARTICLES = 240;
const MAX_PARTICLES = 1100;
/** Wie schnell alte Spuren verblassen (0–1 pro Bild). */
const FADE = 0.055;

export class WindAnimation {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly map: MlMap;
  private readonly colorFor: (speedKmh: number) => string;
  private particles: Particle[] = [];
  private grid: WindGrid | null = null;
  private frame = 0;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement, map: MlMap, colorFor: (speedKmh: number) => string) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.map = map;
    this.colorFor = colorFor;
  }

  setField(field: WindField | null): void {
    const grid = field ? new WindGrid(field) : null;
    this.grid = grid?.valid ? grid : null;
    this.reset();
  }

  /** Canvas an die Kartengröße anpassen (auch bei Displaywechsel). */
  resize(): void {
    const { clientWidth: w, clientHeight: h } = this.map.getCanvas();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(w * this.dpr));
    this.canvas.height = Math.max(1, Math.round(h * this.dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.reset();
  }

  /** Spuren löschen und Teilchen neu verteilen (nach jedem Kartenschwenk). */
  reset(): void {
    const { width, height } = this.canvas;
    this.ctx?.clearRect(0, 0, width, height);
    const wanted = Math.round(
      Math.min(MAX_PARTICLES, Math.max(MIN_PARTICLES, ((width * height) / 1_000_000) * DENSITY)),
    );
    this.particles = Array.from({ length: wanted }, () => this.spawn());
  }

  private spawn(): Particle {
    return {
      x: Math.random() * this.canvas.width,
      y: Math.random() * this.canvas.height,
      age: 0,
      life: 40 + Math.random() * 90,
    };
  }

  start(): void {
    if (this.frame) return;
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.draw();
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(): void {
    const ctx = this.ctx;
    const grid = this.grid;
    if (!ctx || !grid) return;

    // Alte Spuren leicht ausblenden, statt das Bild zu löschen.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${FADE})`;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 1.15 * this.dpr;
    ctx.lineCap = 'round';

    const step = PX_PER_KMH * this.dpr;
    for (const p of this.particles) {
      const lngLat = this.map.unproject([p.x / this.dpr, p.y / this.dpr]);
      const { u, v, speed } = grid.sample(lngLat.lat, lngLat.lng);
      const nx = p.x + u * step;
      // Bildschirm-Y zeigt nach unten, Nordwind also nach oben.
      const ny = p.y - v * step;

      ctx.strokeStyle = this.colorFor(speed);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      p.x = nx;
      p.y = ny;
      p.age += 1;

      const outside = nx < 0 || ny < 0 || nx > this.canvas.width || ny > this.canvas.height;
      if (outside || p.age > p.life) Object.assign(p, this.spawn());
    }
  }
}
