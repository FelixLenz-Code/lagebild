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
      workbox: {
        // Kartenschriften & -symbole (Protomaps-Assets) offline vorhalten, damit
        // die Offline-Karte auch Beschriftungen zeigt, sobald sie einmal online
        // gerendert wurde.
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
