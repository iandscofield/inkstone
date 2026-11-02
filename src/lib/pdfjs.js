// pdf.js setup: rendering, text extraction.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };

/** Load a document for rendering. pdf.js detaches the buffer it is given, so pass a copy. */
export function openPdf(bytes) {
  return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
}

/** Render a page to a new canvas at the given scale (1 = 72 dpi). */
export async function renderPageToCanvas(pdf, index, scale, { background = '#ffffff' } = {}) {
  const page = await pdf.getPage(index + 1);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
  return { canvas, viewport };
}

export function canvasToBytes(canvas, type = 'image/png', quality) {
  return new Promise((resolve) => canvas.toBlob(async (b) => resolve(new Uint8Array(await b.arrayBuffer())), type, quality));
}

export async function pageText(pdf, index) {
  const page = await pdf.getPage(index + 1);
  const tc = await page.getTextContent();
  return tc.items.map((it) => it.str + (it.hasEOL ? '\n' : '')).join('');
}
