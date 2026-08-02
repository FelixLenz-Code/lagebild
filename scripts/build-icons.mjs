#!/usr/bin/env node
/**
 * App-Symbole aus den SVG-Vorlagen erzeugen.
 *
 *   node scripts/build-icons.mjs
 *
 * Vorlagen sind `apps/web/public/icons/icon.svg` (normal) und
 * `icon-maskable.svg` (randlos für Android). Gerastert wird mit dem
 * Chromium, den Playwright ohnehin für die Browser-Prüfungen mitbringt —
 * so kommt keine Bildbibliothek als Abhängigkeit dazu.
 *
 * Die erzeugten PNG liegen **im Repository**: Wer die App nur baut, braucht
 * dieses Skript nicht. Nur wer das Symbol ändert, lässt es einmal laufen.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = join(root, 'apps/web/public/icons');

/** Welche Datei in welcher Größe aus welcher Vorlage. */
const TARGETS = [
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'icon.svg', out: 'apple-touch-icon.png', size: 180 },
  { src: 'icon.svg', out: 'favicon-32.png', size: 32 },
  { src: 'icon.svg', out: 'favicon-16.png', size: 16 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-192.png', size: 192 },
  { src: 'icon-maskable.svg', out: 'icon-maskable-512.png', size: 512 },
];

/** Chromium aus der Playwright-Ablage suchen (dieselbe Stelle wie bei den Tests). */
function findChromium() {
  const base = join(process.env.HOME ?? '', '.cache/ms-playwright');
  if (!existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    if (!dir.startsWith('chromium-')) continue;
    const exe = join(base, dir, 'chrome-linux64/chrome');
    if (existsSync(exe)) return exe;
  }
  return null;
}

/**
 * playwright-core ist keine Abhängigkeit dieses Arbeitsbereichs — es liegt nur
 * dann herum, wenn jemand die Browser-Prüfungen benutzt hat. Deshalb erst der
 * gewöhnliche Weg, dann die pnpm-Ablage absuchen.
 */
async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    /* weiter unten */
  }
  const store = join(root, 'node_modules/.pnpm');
  if (existsSync(store)) {
    for (const dir of readdirSync(store)) {
      if (!dir.startsWith('playwright-core@')) continue;
      const entry = join(store, dir, 'node_modules/playwright-core/index.mjs');
      if (existsSync(entry)) return import(pathToFileURL(entry).href);
    }
  }
  return null;
}

const pw = await loadPlaywright();
if (!pw) {
  console.error('playwright-core nicht gefunden — `pnpm add -D playwright-core` (nur zum Erzeugen nötig).');
  process.exit(1);
}
const { chromium } = pw;

const executablePath = findChromium();
if (!executablePath) {
  console.error('Kein Chromium gefunden (~/.cache/ms-playwright). `npx playwright install chromium`.');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
try {
  for (const t of TARGETS) {
    const svg = await readFile(join(iconDir, t.src), 'utf8');
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
    // Kein Rand, kein Rollbalken — die Zeichnung füllt das Fenster genau aus.
    await page.setContent(
      `<style>html,body{margin:0;padding:0;overflow:hidden}svg{display:block;width:${t.size}px;height:${t.size}px}</style>${svg}`,
    );
    const png = await page.screenshot({ omitBackground: true });
    await writeFile(join(iconDir, t.out), png);
    await page.close();
    console.log(`${t.out.padEnd(24)} ${t.size}×${t.size}  ${(png.length / 1024).toFixed(1)} kB`);
  }
} finally {
  await browser.close();
}
