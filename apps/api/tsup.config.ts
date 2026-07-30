import { defineConfig } from 'tsup';

// Bündelt den Server inkl. der Workspace-Pakete (@lagebild/*) zu einer
// einzelnen ESM-Datei, sodass das Release-Tarball ohne node_modules startet.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  minify: false,
  noExternal: [/@lagebild\//, /^hono/, /@hono\//],
});
