// Recent files. The desktop app keeps the list in its settings folder; the browser
// version remembers File System Access handles in IndexedDB (Chromium only).

const desk = () => window.inkstoneDesktop?.recent;
const DB = 'inkstone';
const STORE = 'recent';
const MAX = 30;

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbAll() {
  const db = await idb();
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}
async function idbPut(item) {
  const db = await idb();
  return new Promise((resolve) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(item); tx.oncomplete = resolve; tx.onerror = resolve; });
}
async function idbDelete(key) {
  const db = await idb();
  return new Promise((resolve) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(key); tx.oncomplete = resolve; tx.onerror = resolve; });
}

/** [{key, name, folder, pages, thumb, opened, pinned, missing}] newest first, pinned first. */
export async function listRecent() {
  let items;
  try {
    if (desk()) items = (await desk().list()).map((r) => ({ ...r, key: r.path }));
    else if (window.indexedDB) items = await idbAll();
    else items = [];
  } catch { items = []; }
  return items.sort((a, b) => (b.pinned - a.pinned) || (b.opened - a.opened));
}

/** Remember an opened or saved document. `handle` is a desktop path handle or a browser FileSystemFileHandle. */
export async function addRecent(handle, { pages, thumb }) {
  try {
    if (desk()) {
      if (handle?.path) await desk().add({ path: handle.path, pages, thumb });
      return;
    }
    if (!window.indexedDB || !handle || typeof handle.queryPermission !== 'function') return;
    const all = await idbAll();
    // The same file may come back as a different handle object; match on isSameEntry.
    let existing = null;
    for (const r of all) { try { if (await r.handle.isSameEntry(handle)) { existing = r; break; } } catch { /* stale */ } }
    const item = { key: existing?.key || crypto.randomUUID(), name: handle.name, handle, pages, thumb: thumb || existing?.thumb, opened: Date.now(), pinned: !!existing?.pinned };
    await idbPut(item);
    const rest = all.filter((r) => r.key !== item.key && !r.pinned).sort((a, b) => b.opened - a.opened);
    for (const r of rest.slice(MAX - 1)) await idbDelete(r.key);
  } catch (e) {
    console.warn('Could not update recent files', e);
  }
}

export async function removeRecent(item) {
  if (desk()) return desk().remove(item.key);
  return idbDelete(item.key);
}

export async function pinRecent(item, pinned) {
  if (desk()) return desk().pin(item.key, pinned);
  return idbPut({ ...item, pinned });
}

export async function clearRecent() {
  if (desk()) return desk().clear();
  for (const r of await idbAll()) if (!r.pinned) await idbDelete(r.key);
}

/** Returns {files: File[], handle} for openFiles, or null if the file can't be opened. */
export async function openRecent(item) {
  if (desk()) {
    const list = await desk().open(item.key);
    if (!list.length) return null;
    return { desktopList: list };
  }
  const h = item.handle;
  if (!h) return null;
  let perm = await h.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') perm = await h.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return null;
  try { return { files: [await h.getFile()], handle: h }; } catch { return null; }
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24); if (d < 7) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined });
}
