#!/usr/bin/env node
/**
 * Baut das **Gefahrgut-Nachschlagewerk** (`apps/web/public/hazmat.json`).
 *
 *   node scripts/build-hazmat.mjs [--pdf /tmp/erg2024.pdf] [--out apps/web/public/hazmat.json]
 *
 * Quelle ist das **Emergency Response Guidebook (ERG) 2024**, herausgegeben vom
 * US-Verkehrsministerium (PHMSA) gemeinsam mit Transport Canada und der SCT
 * Mexiko. Als Werk der US-Bundesregierung ist es gemeinfrei und ausdrücklich
 * zur Weiterverbreitung gedacht; die App nennt es als Quelle.
 *
 * Herausgezogen werden drei Dinge:
 *
 *  1. **Gelbe Seiten** — UN-Nummer → Leitfadennummer und Benennung.
 *  2. **Tabelle 1 (grüne Seiten)** — Ersteinsatz-Abstände für Stoffe, die beim
 *     Einatmen giftig sind: Absperrradius rundum und Schutzabstand stromab, je
 *     für kleine und große Menge, Tag und Nacht.
 *  3. **Leitfadentitel** der orangefarbenen Seiten.
 *
 * Der volle Leitfadentext wird **nicht** übernommen: Er ist englisch, mehrere
 * hundert Seiten lang, und eine selbstgemachte Übersetzung
 * sicherheitsrelevanter Handlungsanweisungen wäre gefährlicher als nützlich.
 * Die App zeigt deshalb Zahlen und Titel und verweist für das Vorgehen auf die
 * ERI-Karte und die Einsatzleitung.
 *
 * Gelesen wird mit `pdftotext` (poppler). Die gelben Seiten stehen zweispaltig,
 * deshalb wird jede Spalte einzeln ausgeschnitten — sonst klebten die Zeilen
 * zweier Stoffe aneinander.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Seitenbreite des ERG in Punkten (aus `pdfinfo`). */
const PAGE_WIDTH = 391.5;
const PAGE_HEIGHT = 549;
/** Trennlinie zwischen den beiden Spalten der gelben Seiten. */
const COLUMN_SPLIT = 197;

function text(pdf, page, opts = {}) {
  const args = ['-f', String(page), '-l', String(page), '-layout'];
  if (opts.x != null) args.push('-x', String(Math.round(opts.x)), '-y', '0', '-W', String(Math.round(opts.w)), '-H', String(Math.round(PAGE_HEIGHT)));
  args.push(pdf, '-');
  return execFileSync('pdftotext', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function pageCount(pdf) {
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  return Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
}

/* ------------------------------------------------------------------ *
 * Gelbe Seiten: UN-Nummer → Leitfaden und Benennung
 * ------------------------------------------------------------------ */

const ENTRY = /^(\d{4})\s+(\d{3}P?)\s+(\S.*)$/;

function parseColumn(block, out) {
  let last = null;
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (/^\s*(ID|No\.)\b/.test(line) || /Name of Material/.test(line)) continue;
    const m = ENTRY.exec(line.trim());
    if (m) {
      last = { id: Number(m[1]), guide: m[2], name: m[3].trim() };
      out.push(last);
      continue;
    }
    // Eingerückte Fortsetzung des Namens der Zeile darüber.
    if (last && /^\s{4,}\S/.test(line) && !/^\s*—/.test(line)) {
      last.name = `${last.name} ${line.trim()}`.replace(/\s+/g, ' ');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Tabelle 1: Ersteinsatz-Abstände
 * ------------------------------------------------------------------ */

/** „30 m  (100 ft)  0.1 km  (0.1 mi)  0.2 km  (0.1 mi)" — ein Block. */
const BLOCK = /(\d+)\s*m\s*\(\s*[\d,]+\s*ft\)\s*([\d.]+\+?)\s*km\s*\([\d.+]+\s*mi\)\s*([\d.]+\+?)\s*km\s*\([\d.+]+\s*mi\)/g;

function parseTable1(pdf, from, to) {
  const table = {};
  for (let page = from; page <= to; page++) {
    const block = text(pdf, page);
    let current = null;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const head = ENTRY.exec(line);
      if (head) {
        current = Number(head[1]);
        // Manche Zeilen tragen Name **und** Zahlen; deshalb kein `continue`.
      }
      if (current == null) continue;
      const blocks = [...line.matchAll(BLOCK)];
      if (!blocks.length) continue;
      const [small, large] = blocks;
      const entry = table[current] ?? (table[current] = {});
      // Die erste Zahlengruppe der Zeile gehört zur kleinen Menge, die zweite
      // zur großen. Fehlt die zweite, steht dort „Refer to Table 3" — dann
      // hängt der Abstand an Tankgröße und Wetter, und die Tabelle schweigt.
      if (small && entry.smallIsolationM == null) {
        entry.smallIsolationM = Number(small[1]);
        entry.smallDayKm = Number(String(small[2]).replace('+', ''));
        entry.smallNightKm = Number(String(small[3]).replace('+', ''));
      }
      if (large && entry.largeIsolationM == null) {
        entry.largeIsolationM = Number(large[1]);
        entry.largeDayKm = Number(String(large[2]).replace('+', ''));
        entry.largeNightKm = Number(String(large[3]).replace('+', ''));
      }
      if (!large && /Refer to Table 3/i.test(line)) entry.largeRefersToTable3 = true;
    }
  }
  return table;
}

/* ------------------------------------------------------------------ *
 * Hauptlauf
 * ------------------------------------------------------------------ */

async function main() {
  const args = process.argv.slice(2);
  let pdf = process.env.ERG_PDF ?? '/tmp/erg2024.pdf';
  let out = 'apps/web/public/hazmat.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--pdf') pdf = args[++i];
    else if (args[i] === '--out') out = args[++i];
  }
  try {
    await stat(pdf);
  } catch {
    console.error(
      `ERG-PDF nicht gefunden: ${pdf}\n` +
        'Das Handbuch liegt frei beim US-Verkehrsministerium:\n' +
        '  https://www.phmsa.dot.gov/training/hazmat/erg/emergency-response-guidebook-erg',
    );
    process.exit(1);
  }

  const pages = pageCount(pdf);
  console.log(`ERG mit ${pages} Seiten wird gelesen …`);

  const materials = [];
  const guides = {};
  let yellowPages = 0;
  let tableFrom = 0;
  let tableTo = 0;

  for (let page = 1; page <= pages; page++) {
    const full = text(pdf, page);

    // Leitfadentitel: die Zeile „GUIDE   <Titel>", darunter die Nummer — und
    // hinter der Nummer steht bei langen Titeln der Rest („113  (Wet/…)").
    const lines = full.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const m = /^\s*GUIDE\s{2,}(\S.*?)\s*$/.exec(lines[i] ?? '');
      const n = /^\s*(\d{3})\b\s*(.*)$/.exec(lines[i + 1] ?? '');
      if (!m || !n || guides[n[1]]) continue;
      guides[n[1]] = `${m[1]} ${n[2] ?? ''}`.replace(/\s+/g, ' ').trim();
    }

    // Grüne Tabelle: Kopfzeile erkennen und die Seitenspanne merken.
    if (/SMALL SPILLS/.test(full) && /LARGE SPILLS/.test(full)) {
      if (!tableFrom) tableFrom = page;
      tableTo = page;
    }

    // Gelbe Seiten: Kopf trägt „ID Guide … Name of Material" in dieser Folge.
    if (!/ID\s+Guide/.test(full) || !/Name of Material/.test(full)) continue;
    if (/SMALL SPILLS/.test(full)) continue; // das ist die grüne Tabelle
    yellowPages++;
    parseColumn(text(pdf, page, { x: 0, w: COLUMN_SPLIT }), materials);
    parseColumn(text(pdf, page, { x: COLUMN_SPLIT, w: PAGE_WIDTH - COLUMN_SPLIT }), materials);
  }

  const table1 = parseTable1(pdf, tableFrom, tableTo);

  // Mehrere Namen je UN-Nummer sind der Normalfall (Synonyme, Schreibweisen).
  // Der erste ist die Hauptbenennung, die übrigen bleiben als Suchhilfe stehen.
  const byId = new Map();
  for (const m of materials) {
    const e = byId.get(m.id);
    if (!e) byId.set(m.id, { id: m.id, guide: m.guide, name: m.name, also: [] });
    else if (e.name !== m.name && !e.also.includes(m.name)) e.also.push(m.name);
  }

  const list = [...byId.values()].sort((a, b) => a.id - b.id);
  const data = {
    source: 'Emergency Response Guidebook 2024 (US DOT/PHMSA, Transport Canada, SCT) — gemeinfrei',
    edition: 2024,
    guides,
    materials: list,
    table1,
  };

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data));
  const size = (await stat(out)).size;
  console.log(
    `  ${yellowPages} gelbe Seiten, ${list.length} UN-Nummern, ` +
      `${Object.keys(table1).length} Einträge in Tabelle 1, ${Object.keys(guides).length} Leitfäden`,
  );
  console.log(`  → ${out} (${(size / 1024).toFixed(0)} kB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
