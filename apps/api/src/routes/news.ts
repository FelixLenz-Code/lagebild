import { Hono } from 'hono';
import type { NewsItem } from '@lagebild/shared';
import { cached } from '../lib/cache.js';
import { fetchJson } from '../lib/http.js';
import { envelope } from '../lib/envelope.js';

/**
 * Aktuelle Meldungen der Tagesschau-API (bund.dev). Wichtig: Endpunkt ohne
 * abschließenden Slash, sonst leitet der Server auf eine leere Antwort um.
 */
export const newsRoute = new Hono();

interface RawNews {
  sophoraId?: string;
  externalId?: string;
  title?: string;
  firstSentence?: string;
  date?: string;
  ressort?: string;
  shareURL?: string;
  detailsweb?: string;
  type?: string;
}

newsRoute.get('/', async (c) => {
  const cache = cached<NewsItem[]>('news:tagesschau', 300);
  if (cache.hit) return c.json(envelope(cache.hit, 'Tagesschau', true));

  const body = await fetchJson<{ news?: RawNews[] }>('https://www.tagesschau.de/api2u/news');
  const items: NewsItem[] = (body.news ?? [])
    .filter((n) => n.title && (n.shareURL || n.detailsweb))
    .slice(0, 15)
    .map((n) => ({
      id: n.sophoraId ?? n.externalId ?? (n.shareURL as string),
      title: (n.title as string).trim(),
      summary: n.firstSentence || undefined,
      url: (n.shareURL ?? n.detailsweb) as string,
      publishedAt: n.date ?? null,
      topic: n.ressort || undefined,
    }));

  cache.set(items);
  return c.json(envelope(items, 'Tagesschau'));
});
