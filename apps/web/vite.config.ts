import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Der Dev-Server proxyt /api an den lokalen Hono-Server (Port 8787),
// im Prod-Betrieb liefert derselbe Hono-Server das gebaute Bundle aus.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      /*
       * Als **eigene Datei** statt eingebettet. In der Voreinstellung schreibt
       * das Plugin die Registrierung als `<script>` mitten in die index.html —
       * und genau das verbietet die Inhaltsrichtlinie des Servers
       * (`script-src 'self'`). Ohne diese Zeile bliebe die App ohne Service
       * Worker, also ohne Offline-Betrieb.
       */
      injectRegister: 'script-defer',
      workbox: {
        /*
         * Schriften und Symbole der Karte liegen unter `public/basemaps` und
         * gehören in den Vorrat — sonst steht eine kalt gestartete Offline-App
         * ohne einen einzigen Namen auf der Karte da. `.pbf` und `.json` sind
         * in der Voreinstellung nicht dabei, deshalb die eigene Liste.
         */
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,pbf,json}'],
        /*
         * Eigener Anteil am Service Worker: der Wecker für Warnungen. Workbox
         * erzeugt den Worker selbst, deshalb wird der Zusatz hineingezogen
         * statt die Erzeugung auf `injectManifest` umzustellen — sonst müsste
         * das ganze Zwischenspeichern von Hand nachgebaut werden.
         */
        importScripts: ['/sw-warnings.js'],
        // Ein Symbolsatz kann ein paar Megabyte groß sein.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        // Wurden die Dateien beim Bauen nicht geholt, lädt die Karte sie doch
        // von Protomaps — dann wenigstens ab dem ersten Mal aus dem Vorrat.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/protomaps\.github\.io\/basemaps-assets\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'map-assets',
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      manifest: {
        name: 'Lagebild — Sicher unterwegs',
        short_name: 'Lagebild',
        description: 'Wetter, amtliche Warnungen, Verkehr und News für sicheres Bewegen.',
        theme_color: '#1d4e73',
        background_color: '#0f0f10',
        display: 'standalone',
        lang: 'de',
        start_url: '/',
        scope: '/',
        orientation: 'any',
        categories: ['navigation', 'weather', 'travel'],
        // Ohne Symbole gilt eine PWA als nicht installierbar. `maskable` gibt
        // Android die Freiheit, den Rand nach eigener Form zu beschneiden —
        // dort liegt deshalb nichts Wesentliches.
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
