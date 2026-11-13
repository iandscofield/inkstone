// Renders build/icon.png (512x512) from an inline SVG using Electron's offscreen renderer.
// Run with: npm run icon
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

// Inkstone: a slate grinding stone seen from above, with a pool of ink in its
// carved well, an ink stick resting across it, and a small red seal.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f1e7"/><stop offset="1" stop-color="#e9dfcc"/></linearGradient>
    <linearGradient id="stone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5b6472"/><stop offset="1" stop-color="#2a2f38"/></linearGradient>
    <linearGradient id="face" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d4450"/><stop offset="1" stop-color="#262b33"/></linearGradient>
    <radialGradient id="ink" cx="0.4" cy="0.35" r="0.8"><stop offset="0" stop-color="#1e2a44"/><stop offset="0.55" stop-color="#0b1020"/><stop offset="1" stop-color="#05070d"/></radialGradient>
    <linearGradient id="stick" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#16181d"/><stop offset="0.5" stop-color="#2b2f37"/><stop offset="1" stop-color="#121418"/></linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#3b2f1f" flood-opacity="0.35"/></filter>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="108" fill="url(#tile)"/>
  <g filter="url(#shadow)">
    <rect x="104" y="80" width="304" height="360" rx="64" fill="url(#stone)"/>
    <rect x="124" y="100" width="264" height="320" rx="48" fill="url(#face)"/>
    <!-- carved ink well at the top -->
    <path d="M150 168c0-38 46-58 106-58s106 20 106 58v6H150z" fill="#1a1e25"/>
    <path d="M158 170c0-32 42-48 98-48s98 16 98 48c0 10-44 18-98 18s-98-8-98-18z" fill="url(#ink)"/>
    <path d="M196 140c18-8 40-11 62-11" stroke="#7d8fb8" stroke-width="7" stroke-linecap="round" fill="none" opacity="0.55"/>
    <!-- grinding surface with a wet sheen -->
    <path d="M150 212h212v148a28 28 0 0 1-28 28H178a28 28 0 0 1-28-28z" fill="#30363f"/>
    <ellipse cx="256" cy="292" rx="70" ry="44" fill="#141922" opacity="0.75"/>
    <ellipse cx="236" cy="278" rx="26" ry="10" fill="#8394bb" opacity="0.25"/>
  </g>
  <!-- ink stick resting diagonally -->
  <g transform="rotate(-32 300 330)">
    <rect x="232" y="300" width="190" height="52" rx="10" fill="url(#stick)"/>
    <rect x="246" y="312" width="96" height="28" rx="4" fill="none" stroke="#b08d4a" stroke-width="3" opacity="0.85"/>
    <rect x="404" y="300" width="18" height="52" rx="6" fill="#0c0d10"/>
  </g>
  <!-- red seal -->
  <rect x="364" y="372" width="74" height="74" rx="12" fill="#c8312b" transform="rotate(6 401 409)"/>
  <path d="M386 392h30M401 392v38M388 430h26" stroke="#f6f1e7" stroke-width="7" stroke-linecap="round" fill="none" transform="rotate(6 401 409)"/>
</svg>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  await win.loadURL(`data:text/html,<html><body style="margin:0;background:transparent">${encodeURIComponent(svg)}</body></html>`);
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
  writeFileSync(new URL('../build/icon.png', import.meta.url), img.resize({ width: 512, height: 512 }).toPNG());
  if (process.argv.includes('--svg')) writeFileSync(new URL('../build/icon.svg', import.meta.url), svg);
  app.quit();
});
