import { defineConfig } from 'vite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// Ship the OCR engine and English language data with the app so OCR works offline.
// Files are copied into public/ocr (git-ignored), which Vite serves in dev and copies into dist.
const OCR_FILES = {
  'worker.min.js': 'node_modules/tesseract.js/dist/worker.min.js',
  'core/tesseract-core-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-lstm.wasm.js',
  'core/tesseract-core-simd-lstm.wasm.js': 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js',
  'lang/eng.traineddata.gz': 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz',
};

function ocrAssets() {
  return {
    name: 'inkstone-ocr-assets',
    buildStart() {
      for (const [out, src] of Object.entries(OCR_FILES)) {
        const dest = resolve(root, 'public/ocr', out);
        if (existsSync(dest)) continue;
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(resolve(root, src), dest);
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [ocrAssets()],
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
});
