# Lagebild

Eine **offline-first PWA**, die Informationen fürs sichere Bewegen in der Welt bündelt:
Wetter & Regenradar, amtliche Warnungen (NINA/BBK), Verkehr (Autobahn), Bahn/ÖPNV,
Pegelstände, Luftqualität und relevante News — standortbezogen und auf Wunsch
pro Bundesland offline verfügbar. Fokus: Deutschland.

## Architektur

Monorepo (pnpm workspaces):

| Paket | Zweck |
| --- | --- |
| `apps/web` | React-PWA (Vite). Zoombare Lagekarte, Kacheln, Offline-Cache. |
| `apps/api` | Hono-Proxy. Normalisiert externe Quellen, umgeht CORS/Rate-Limits, cached. |
| `packages/shared` | Gemeinsame TypeScript-Datentypen. |

Der Server ist **zustandslos** (nur Proxy + kurzer Cache) — die Offline-Daten
liegen im Browser. Datenquellen sind überwiegend freie, offizielle APIs
(Bright Sky/DWD, warnung.bund.de/NINA, Autobahn, PEGELONLINE, UBA, Tagesschau, DB).

## Entwicklung

```bash
pnpm install
pnpm dev        # startet API (Port 8787) + Web (Port 5173) parallel
```

Frontend: http://localhost:5173 · API-Health: http://localhost:8787/api/health

```bash
pnpm build      # baut alle Pakete
pnpm typecheck  # Typprüfung über alle Pakete
```

## Deployment

Läuft hinter einem eigenen Reverse-Proxy (TLS dort terminieren). Installation und
Update erfolgen mit **einem Befehl** aus diesem Repo (siehe `install.sh`, folgt).
Der Hono-Server liefert im Prod-Betrieb sowohl die API als auch das gebaute
PWA-Bundle aus.

## Lizenz

MIT
