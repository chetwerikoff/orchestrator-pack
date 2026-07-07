import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const uiRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: uiRoot,
  base: '/',
  build: {
    outDir: path.join(uiRoot, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
  },
});
