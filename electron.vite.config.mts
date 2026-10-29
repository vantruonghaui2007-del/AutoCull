import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          worker: resolve(import.meta.dirname, 'src/worker/index.ts'),
        },
        // Platform-specific helper packages: only one of them is installed on a given OS.
        external: ['exiftool-vendored.exe', 'exiftool-vendored.pl'],
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html'), localAnalysis: resolve(import.meta.dirname, 'src/renderer/local-analysis.html') },
      },
    },
  },
});
