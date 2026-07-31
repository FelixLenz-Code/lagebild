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
  // `ws` muss mit ins Bundle: der AIS-Stream läuft über WebSockets, und
  // Node 20 bringt noch keinen stabilen WebSocket-Client mit.
  noExternal: [/@lagebild\//, /^hono/, /@hono\//, /^ws$/],
  // `ws` ist CommonJS und lädt Node-Module per require — im ESM-Bundle gibt es
  // das nicht. Der Banner stellt ein passendes `require` bereit.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
});
