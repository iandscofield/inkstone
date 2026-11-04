// Renders build/icon.png (512x512) from an inline SVG using Electron's offscreen renderer.
// Run with: npm run icon
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ef4b3f"/><stop offset="1" stop-color="#c5221a"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="104" fill="url(#g)"/>
  <path d="M150 92h150l92 92v236a28 28 0 0 1-28 28H150a28 28 0 0 1-28-28V120a28 28 0 0 1 28-28z" fill="#fff"/>
  <path d="M300 92v64a28 28 0 0 0 28 28h64z" fill="#f7c2bd"/>
  <text x="257" y="372" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-weight="800" font-size="104" fill="#c5221a">PDF</text>
  <rect x="166" y="230" width="180" height="14" rx="7" fill="#e5e7eb"/><rect x="166" y="262" width="130" height="14" rx="7" fill="#e5e7eb"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,<html><body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body></html>`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(new URL('../build/icon.png', import.meta.url), img.resize({ width: 512, height: 512 }).toPNG());
  app.quit();
});
