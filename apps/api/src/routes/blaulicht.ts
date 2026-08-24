import { Hono } from 'hono';
import type { BlaulichtItem, BlaulichtKind, NewsPlace } from '@lagebild/shared';
import { readCoords } from '../lib/geo.js';
import { cached } from '../lib/cache.js';
import { fetchText } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';
import { STATE_NAME, statesOf } from '../lib/states.js';
import { GERMANY_BOX, lookupPlace, type LookupBudget } from '../lib/photon.js';

/**
 * Meldungen von Polizei, Feuerwehr, THW und Zoll — gesammelt über das
 * Blaulicht-Portal von news aktuell (presseportal.de). Frei, ohne Schlüssel,
 * als RSS; neben dem bundesweiten Strom gibt es je Bundesland einen eigenen
 * Feed (der Pfad heißt aus Altersgründen `polizei`, enthält aber ebenso
 * `FW-`, `LKA-` und `BPOL-`-Meldungen).
 *
 * **Was das ist und was nicht:** Das sind Pressemeldungen, keine
 * Einsatzdaten. Sie erscheinen Minuten bis Stunden nach dem Ereignis, und
 * zwischen echten Einsätzen stehen Zeugenaufrufe und Nachwuchswerbung —
 * deshalb trägt jede Meldung ein `incident`-Kennzeichen. Eine bundesweite
 * Live-Schnittstelle der Leitstellen gibt es nicht.
 *
 * **Bedingung des Anbieters:** Die Texte gehören news aktuell bzw. der
 * herausgebenden Dienststelle. Die App zeigt daher nur Kopfzeile und Anriss
 * mit Rücklink auf die Originalmeldung, nie den Volltext.
 */
export const blaulichtRoute = new Hono();

const BASE = process.env.PRESSEPORTAL_BASE ?? 'https://www.presseportal.de';
const NATIONAL_FEED = `${BASE}/rss/polizei.rss2`;
const stateFeed = (name: string) => `${BASE}/rss/polizei/r/${encodeURIComponent(name)}.rss2`;

/** Höchstens so viele neue Ortsabfragen je Aktualisierung. */
const MAX_LOOKUPS = 16;
/** Je Meldung höchstens so viele Schreibweisen des Ortes probieren. */
const CANDIDATES_PER_ITEM = 2;
/** Der Feed selbst nennt `ttl 6` — drei Minuten sind höflich und aktuell genug. */
const CACHE_TTL = 180;
/**
 * Älteres fliegt raus. Die Landesfeeds fassen ebenfalls 15 Einträge, reichen
 * in verkehrsarmen Ländern damit aber über eine Woche zurück — was so alt ist,
 * gehört in kein Lagebild.
 */
const MAX_AGE_MS = 72 * 3600 * 1000;

/* ------------------------------------------------------------------ */
/* RSS lesen                                                           */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * Ein Zeichen aus einer numerischen Entität — oder die Entität selbst zurück.
 *
 * `String.fromCodePoint` **wirft** bei allem über U+10FFFF. Ungeprüft nahm ein
 * einziges `&#1114112;` in einer Meldung den ganzen Feed mit: Der Fehler flog
 * bis `loadFeed`, und die leere Liste wurde dort auch noch gecacht. Auf
 * presseportal.de veröffentlichen Dritte selbst — auf sauberes Eingabematerial
 * ist hier kein Verlass.
 */
function zeichen(code: number, roh: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return roh;
  // Ersatzzeichen-Hälften sind allein kein gültiger Codepoint.
  if (code >= 0xd800 && code <= 0xdfff) return roh;
  return String.fromCodePoint(code);
}

/** XML-Entitäten auflösen, auch die numerischen („&#8211;" = Gedankenstrich). */
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (all, hex: string) => zeichen(parseInt(hex, 16), all))
    .replace(/&#(\d+);/g, (all, dec: string) => zeichen(Number(dec), all))
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all)
    .trim();
}

/**
 * Ein Feld aus einem `<item>` holen. Bewusst mit regulärem Ausdruck statt einer
 * XML-Bibliothek — der Feed ist flach und gleichförmig, und das Projekt liest
 * das Funkwetter-XML genauso.
 */
function field(item: string, tag: string): string {
  const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m?.[1]) return '';
  const raw = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return decode(raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
}

interface RawItem {
  title: string;
  description: string;
  link: string;
  guid: string;
  pubDate: string;
  agency: string;
}

function parseFeed(xml: string): RawItem[] {
  const items: RawItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1]!;
    const title = field(body, 'title');
    const link = field(body, 'link');
    if (!title || !link) continue;
    items.push({
      title,
      description: field(body, 'description'),
      link,
      guid: field(body, 'guid') || link,
      pubDate: field(body, 'pubDate'),
      agency: field(body, 'source'),
    });
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* Einordnung                                                          */
/* ------------------------------------------------------------------ */

/**
 * Absenderkürzel am Anfang der Überschrift. Drei Schreibweisen kommen vor:
 * „POL-BI:", „BPOL NRW:" und „FW Dinslaken:" — Bindestrich, Leerzeichen oder
 * gar nichts. Verlangt werden mindestens zwei Großbuchstaben, damit eine
 * gewöhnliche Ortsangabe („Bonn: Feuer in …") nicht als Kürzel durchgeht.
 * Die zweite Schreibweise deckt Verbandskürzel wie „VdF-NRW" ab.
 */
const AGENCY_PREFIX =
  /^((?:[A-ZÄÖÜ]{2,6}|[A-ZÄÖÜ][a-zäöü]{1,2}[A-ZÄÖÜ]{1,4}))(?:[-–][A-Za-zÄÖÜäöü0-9]{1,14}|\s[A-ZÄÖÜ][A-Za-zÄÖÜäöüß0-9.-]{1,16})?:\s*/;

const KIND_BY_PREFIX: [RegExp, BlaulichtKind][] = [
  [/^(FW|FFW|VDF|LFV|KFV)$/, 'fire'],
  [/^THW$/, 'thw'],
  [/^(HZA|ZOLL|GZD)$/, 'customs'],
  [/^(POL|LPI|LKA|LPD|LPP|PP|PD|KPB|BPOL|BPOLI|BP|BKA)$/, 'police'],
];

function kindOf(title: string, agency: string): BlaulichtKind {
  const prefix = title.match(AGENCY_PREFIX)?.[1]?.toUpperCase();
  if (prefix) {
    for (const [re, kind] of KIND_BY_PREFIX) if (re.test(prefix)) return kind;
  }
  // Ohne brauchbares Kürzel entscheidet der Name der Dienststelle. Eng
  // gefasst: „Bund Deutscher Kriminalbeamter" ist eine Berufsvertretung und
  // keine Dienststelle — solche Verbandsmeldungen bleiben `other`.
  if (/feuerwehr|rettungsdienst|brandschutz/i.test(agency)) return 'fire';
  if (/polizei|kriminalpolizei|landeskriminalamt|bundeskriminalamt/i.test(agency)) return 'police';
  if (/thw|technisches hilfswerk/i.test(agency)) return 'thw';
  if (/zoll|hauptzollamt/i.test(agency)) return 'customs';
  return 'other';
}

/**
 * Kürzel abschneiden — zweimal, weil manche Dienststellen es doppelt setzen
 * („FW-BN: FW-BN: 2. Folgemeldung").
 */
function stripPrefix(title: string): string {
  let out = title;
  for (let i = 0; i < 2; i++) out = out.replace(AGENCY_PREFIX, '');
  // Manche Dienststellen führen eine eigene Zählung und rahmen den Titel mit
  // Strichen ein: „Nr.: 0512--Schule in Horn beschmiert--".
  out = out
    .replace(/^Nr\.?:?\s*\d+\s*/i, '')
    .replace(/^-{2,}\s*/, '')
    .replace(/\s*-{2,}$/, '')
    .trim();
  return out || title;
}

/**
 * Öffentlichkeitsarbeit — hat Vorrang vor den Ereigniswörtern, sonst wird aus
 * „Brandschutzerziehung in der Grundschule" ein Brand und aus „Bilanz der
 * Verkehrsunfälle 2025" ein Unfall.
 */
const PUBLIC_RELATIONS =
  /pressegespräch|pressekonferenz|presseeinladung|terminhinweis|jahresbilanz|jahresbericht|bilanz|statistik|karriere|nachwuchs|ausbildung|einstellungsberatung|tag der offenen|informationsveranstaltung|infoveranstaltung|brandschutzerziehung|präventi|aufklärungskampagne|kampagne|ehrung|geehrt|jubiläum|beförder|verabschied|übung|festakt|richtfest|neue wache|zu besuch|besucht|projekt|umfrage|korrektur|plakette|auszeichnung|ausgezeichnet|förder|ehrenamt|jugendfeuerwehr|mitgliederversammlung|hauptversammlung|warnt vor|informiert über|rückblick|kontrollwoche|schwerpunktkontrolle|ferienreisekontrollen/i;

/**
 * Wörter, die auf ein tatsächliches Ereignis hindeuten. Wie bei den
 * Nachrichten ohne `\b` am Ende, weil das Stichwort im Deutschen meist in
 * einer Zusammensetzung steckt („Verkehrsunfall", „Vollsperrung").
 */
const INCIDENT =
  /(?<![a-zäöüß])(brand|brennt|feuer(?!wehr)|rauch|explosion|alarmier|einsatz|notruf|rettung|vermisst|verletzt|getötet|tote|leiche|festnahme|festgenommen|raub|überfall|einbruch|diebstahl|randalier|bedroh|schuss|schüsse|messer|sturz|gestürzt|kollidiert|verpuffung|gefahrgut|evakuier|hochwasser|sturm|unwetter|ölspur|tierrettung|wasserschaden|drohung|bombendrohung|verfolgungsfahrt|flucht|geflüchtet)|unfall|absturz|kollision|zusammenstoß|sperrung|entgleis|blindgänger|explosion|brandstiftung|körperverletzung|sachbeschädigung|widerstand|trunkenheitsfahrt|verkehrsunfall|waldbrand|einsatz|einsatzkräfte|alarmierung/i;

/**
 * Sammelmeldungen tragen im Kopf gar kein Ereignis („Pressemeldungen für den
 * Landkreis Vechta") — nur dann lohnt der Blick in den Anriss.
 */
const COLLECTIVE = /^(pressemeldungen|pressemitteilungen|meldungen|polizeimeldungen|pressebericht)\b/i;

/**
 * Die Überschrift entscheidet. Der Anriss zählt nur bei Sammelmeldungen —
 * sonst macht ein beiläufig erwähnter „Einsatz der Feuerwehr" aus jeder
 * Ehrungsmeldung einen Vorfall (dieselbe Lehre wie bei den Nachrichten).
 */
function isIncident(title: string, summary: string): boolean {
  if (PUBLIC_RELATIONS.test(title)) return false;
  if (INCIDENT.test(title)) return true;
  if (!COLLECTIVE.test(title)) return false;
  return !PUBLIC_RELATIONS.test(summary) && INCIDENT.test(summary);
}

/**
 * Ortsangabe. Jede Meldung beginnt mit der Ortsmarke der Nachrichtenagentur:
 * „Bielefeld (ots) - …", „Moos, L193 (ots) - …". Das ist ein echter Ortsname
 * und damit deutlich verlässlicher als die Schlagworte der Nachrichten-Route.
 *
 * Geliefert werden mehrere Schreibweisen, weil die Marke zusammengesetzt sein
 * kann: „Cloppenburg/Vechta" (zwei Dienststellen), „VS-Villingen" (amtliche
 * Abkürzung), „Moos, L193" (Ort mit Straße).
 */
function placeCandidates(description: string, title: string): string[] {
  const mark = description.match(/^([^()]{2,60}?)\s*\(ots\)/)?.[1]?.trim();
  const out: string[] = [];
  const add = (v: string | undefined) => {
    const name = v?.trim().replace(/\s+/g, ' ');
    // Anders als bei den Nachrichten-Schlagworten werden Landesnamen **nicht**
    // verworfen: „Bremen (ots)" meint die Stadt, nicht das Land.
    if (!name || name.length < 3) return;
    if (!out.includes(name)) out.push(name);
  };

  if (mark) {
    // Erster Bestandteil vor Schrägstrich oder Komma ist der Ort selbst.
    const first = mark.split(/[/,]/)[0]!.trim();
    add(first);
    // Amtliche Abkürzung abwerfen: „VS-Villingen" → „Villingen".
    add(first.match(/^[A-ZÄÖÜ]{2,3}-(.+)$/)?.[1]);
  }
  if (!out.length) {
    // Manche Dienststellen setzen den Ort stattdessen in die Überschrift:
    // „POL-KN: (Eschbronn / Lkr. Rottweil) …".
    add(title.match(/\(([A-ZÄÖÜ][^()/,]{2,40})/)?.[1]);
  }
  return out.slice(0, CANDIDATES_PER_ITEM);
}

/* ------------------------------------------------------------------ */
/* Route                                                               */
/* ------------------------------------------------------------------ */

/**
 * Gesammelte Meldungen je Feed.
 *
 * **Warum gesammelt wird:** Ein Feed fasst 15 Einträge — bei der Meldungsdichte
 * im bundesweiten Strom sind das rund zwölf Minuten. Ohne Sammeln zeigte die
 * Ebene also nur einen Wimpernschlag Lage. Dasselbe Muster benutzen im Projekt
 * schon der AIS- und der Blitz-Sammler: im Speicher halten, nach Alter
 * verwerfen, Menge deckeln.
 *
 * Gesammelt wird **je Feed**, nicht global: Nur so bleibt die Zuordnung
 * „kommt aus dem Landesfeed am Standort" erhalten, wenn zwei Nutzer an
 * verschiedenen Orten sitzen.
 */
const collected = new Map<string, Map<string, BlaulichtItem>>();
/** Obergrenze je Feed — 17 Feeds × 400 Meldungen sind unkritisch, unbegrenzt wäre es nicht. */
const MAX_PER_FEED = 400;

function storeOf(feed: string): Map<string, BlaulichtItem> {
  let store = collected.get(feed);
  if (!store) collected.set(feed, (store = new Map()));
  return store;
}

function timeOf(item: BlaulichtItem): number {
  return item.publishedAt ? Date.parse(item.publishedAt) : 0;
}

/** Neue Meldungen aufnehmen, Altes verwerfen, Menge deckeln. */
function ingest(feed: string, items: BlaulichtItem[]): void {
  const store = storeOf(feed);
  for (const item of items) store.set(item.id, item);
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [id, item] of store) if (timeOf(item) < cutoff) store.delete(id);
  if (store.size <= MAX_PER_FEED) return;
  // Älteste zuerst hinaus.
  const byAge = [...store.entries()].sort((a, b) => timeOf(a[1]) - timeOf(b[1]));
  for (const [id] of byAge.slice(0, store.size - MAX_PER_FEED)) store.delete(id);
}

async function loadFeed(url: string): Promise<RawItem[]> {
  // Der Cache liegt auf dem Feed, nicht auf der Antwort: Zwei Nutzer im selben
  // Land teilen sich den Abruf, auch wenn ihre Feedkombination verschieden ist.
  const cache = cached<RawItem[]>(`blaulicht:feed:${url}`, CACHE_TTL);
  if (cache.hit) return cache.hit;
  try {
    return cache.set(parseFeed(await fetchText(url, { timeoutMs: 9000 })));
  } catch {
    // Ein ausgefallener Landesfeed darf die übrigen nicht mitreißen.
    return cache.set([]);
  }
}

/** Rohe Feed-Einträge in fertige Meldungen übersetzen (samt Ortssuche). */
async function toItems(
  raw: RawItem[],
  regional: boolean,
  known: Map<string, BlaulichtItem>,
  budget: LookupBudget,
): Promise<BlaulichtItem[]> {
  const out: BlaulichtItem[] = [];
  for (const r of raw) {
    // Schon gesehene Meldungen nicht erneut verorten — das spart die
    // allermeisten Ortsabfragen, weil sich je Abruf nur wenige ändern.
    const before = known.get(r.guid);
    if (before) {
      out.push(before);
      continue;
    }
    // Der Anriss beginnt mit der Ortsmarke — die gehört nicht in den Text.
    const summary = r.description.replace(/^[^()]{2,60}?\s*\(ots\)\s*-?\s*/, '').trim();
    let place: NewsPlace | undefined;
    let rough: NewsPlace | undefined;
    for (const name of placeCandidates(r.description, r.title)) {
      // **Bewusst bundesweit gesucht, nicht im Rechteck des Feeds:** Die
      // Landesfeeds führen fremde Meldungen mit (im NRW-Feed standen Itzehoe
      // und Offenburg). Die Ortsmarke ist dafür ein echter Ortsname und
      // trägt die Suche auch ohne Landeseingrenzung.
      const hit = await lookupPlace(name, GERMANY_BOX, budget);
      if (!hit) continue;
      if (!hit.approximate) {
        place = hit;
        break;
      }
      // Bei den Stadtstaaten liefert die Ortssuche das Land — als grober Ort
      // brauchbar, aber erst, wenn keine genauere Schreibweise trifft.
      rough ??= hit;
    }
    place ??= rough;

    const published = r.pubDate ? new Date(r.pubDate) : null;
    out.push({
      id: r.guid,
      // Das Kürzel sagt dem Leser nichts — die Dienststelle steht in `agency`.
      title: stripPrefix(r.title),
      summary: summary || undefined,
      url: r.link,
      publishedAt: published && !Number.isNaN(published.getTime()) ? published.toISOString() : null,
      agency: r.agency || 'Presseportal',
      kind: kindOf(r.title, r.agency),
      incident: isIncident(r.title, summary),
      place,
      regional: regional || undefined,
    });
  }
  return out;
}

blaulichtRoute.get('/', async (c) => {
  const coords = readCoords(c);
  const states = coords ? statesOf(coords) : [];
  const feeds = [NATIONAL_FEED, ...states.map((s) => stateFeed(STATE_NAME[s]))];

  const budget: LookupBudget = { left: MAX_LOOKUPS };
  const loaded = await Promise.all(feeds.map((f) => loadFeed(f)));
  for (const [i, raw] of loaded.entries()) {
    const feed = feeds[i]!;
    ingest(feed, await toItems(raw, i > 0, storeOf(feed), budget));
  }

  // Ausgegeben wird die Vereinigung der angefragten Feeds. Entdoppelt über die
  // Meldungs-ID (dieselbe Meldung steht im Landes- und im Bundesfeed), und der
  // Landeseintrag gewinnt, weil nur er das `regional`-Kennzeichen trägt.
  const merged = new Map<string, BlaulichtItem>();
  for (const feed of feeds) for (const [id, item] of storeOf(feed)) merged.set(id, item);

  // **Nach Zeit sortieren, nicht nach Herkunft.** Bei den Nachrichten steht das
  // Regionale bewusst oben; hier wäre das falsch, weil die Landesfeeds weit
  // zurückreichen — es standen elf Tage alte Meldungen über den aktuellen.
  const items = [...merged.values()].sort((a, b) => timeOf(b) - timeOf(a));
  return c.json(envelope(items, 'Presseportal (news aktuell)'));
});
