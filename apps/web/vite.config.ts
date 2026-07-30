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
      manifest: {
        name: 'Lagebild — Sicher unterwegs',
        short_name: 'Lagebild',
        description: 'Wetter, amtliche Warnungen, Verkehr und News für sicheres Bewegen.',
        theme_color: '#1d4e73',
        background_color: '#0f0f10',
        display: 'standalone',
        lang: 'de',
        icons: [],
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
