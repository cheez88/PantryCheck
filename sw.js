// Pantry Check service worker: offline support and update notices.
// Your saved data (history, label results, setup) lives in the browser's local storage,
// not in these caches, so updating or clearing these caches never touches it.

const VERSION = '2026-10-09.1';                  // change this when sw.js itself changes
const CACHE = 'pantry-check-app-' + VERSION;     // app files: replaced on each service worker update
const DATA_CACHE = 'pantry-check-data';          // product lookups, kept across updates for offline use
const DATA_LIMIT = 200;

const SCOPE = self.registration.scope;
const PAGE_NAMES = ['pantry-check.html', 'index.html'];    // whichever name the app is uploaded as
const SHELL = new URL('__app-shell__', SCOPE).href;   // last good copy of the app page, used as an offline fallback
const ASSETS = ['manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png']
  .map(a => new URL(a, SCOPE).href);
const CDN_FILES = ['https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js'];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

let pageUpdated = false;
let pageCheck = Promise.resolve();   // the latest background check of the app page
// Addresses that can be the app: either file name, or the folder itself (which serves index.html)
const isAppAddress = key => {
  if (!key.startsWith(SCOPE)) return false;
  const rest = key.slice(SCOPE.length);
  return rest === '' || PAGE_NAMES.includes(rest);
};
// Only ever save a page that is actually the app, never an error page or folder listing
const isAppContent = text => text.includes('<title>Pantry Check</title>');
const noSearch = u => { const x = new URL(u); x.search = ''; x.hash = ''; return x.href; };

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const name of PAGE_NAMES) {
      const url = new URL(name, SCOPE).href;
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok && isAppContent(await res.clone().text())) {
          await cache.put(url, res.clone());
          await cache.put(SHELL, res);
          break;
        }
      } catch {}
    }
    await Promise.all([...ASSETS, ...CDN_FILES].map(u =>
      fetch(u, { cache: 'no-cache' }).then(r => r.ok ? cache.put(u, r) : null).catch(() => null)));
  })());
  // Not calling skipWaiting here: an update waits until you tap "Update" in the app
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys())
      if (key.startsWith('pantry-check-app-') && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  const type = event.data && event.data.type;
  if (type === 'SKIP_WAITING') self.skipWaiting();
  // The app asks once it has loaded; answer after the background check has finished
  if (type === 'IS_PAGE_UPDATED' && event.source)
    event.waitUntil(pageCheck.then(() => { if (pageUpdated) event.source.postMessage({ type: 'PAGE_UPDATED' }); }));
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (req.mode === 'navigate' && req.url.startsWith(SCOPE))
    return event.respondWith(isAppAddress(noSearch(req.url)) ? appPage(event) : otherPage(event));
  if (url.hostname === 'world.openfoodfacts.org' && url.pathname.startsWith('/api/v2/product/'))
    return event.respondWith(product(event));
  if (ASSETS.includes(noSearch(req.url)) || CDN_HOSTS.includes(url.hostname)) return event.respondWith(staleWhileRevalidate(event));
});

// The app page opens instantly from the cache, then checks for a newer copy in the background.
// If the copy online is different, it's saved and the app shows "A new version is ready".
async function appPage(event) {
  const cache = await caches.open(CACHE);
  const key = noSearch(event.request.url);
  const cached = await cache.match(key);
  const cachedCopy = cached ? cached.clone() : null;   // copy now: the original is handed to the screen
  const network = fetch(key, { cache: 'no-cache' }).then(async res => {
    if (!res.ok) return { res, app: false };
    const fresh = await res.clone().text();
    if (!isAppContent(fresh)) return { res, app: false };
    const old = cachedCopy ? await cachedCopy.text() : null;
    await cache.put(key, res.clone());
    await cache.put(SHELL, res.clone());
    if (old !== null && old !== fresh) {
      pageUpdated = true;
      const wins = await self.clients.matchAll({ type: 'window' });
      wins.forEach(w => w.postMessage({ type: 'PAGE_UPDATED' }));
    } else if (old !== null) {
      pageUpdated = false;
    }
    return { res, app: true };
  });
  pageCheck = network.catch(() => {});
  event.waitUntil(pageCheck);
  if (cached) return cached;
  try {
    const { res, app } = await network;
    if (app) return res;
    // e.g. the folder address when the app is uploaded as pantry-check.html: show the app anyway
    return (await cache.match(SHELL)) || res;
  } catch {
    return (await cache.match(SHELL)) || Response.error();
  }
}

// Any other address in the app's folder (e.g. the folder itself, if there's no index.html):
// use it if it exists, otherwise open the app. Never saved, so error pages can't stick.
async function otherPage(event) {
  const shell = () => caches.open(CACHE).then(c => c.match(SHELL));
  try {
    const res = await fetch(event.request);
    return res.ok ? res : ((await shell()) || res);
  } catch {
    return (await shell()) || Response.error();
  }
}

// Product lookups: always try the database first, fall back to the last copy when offline
async function product(event) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(event.request);
    if (res.ok) event.waitUntil(cache.put(event.request, res.clone()).then(() => trim(cache)));
    return res;
  } catch (err) {
    const hit = await cache.match(event.request);
    if (hit) return hit;
    throw err;
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - DATA_LIMIT; i++) await cache.delete(keys[i]);
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request);
  const network = fetch(event.request).then(res => {
    if (res.ok || res.type === 'opaque') event.waitUntil(cache.put(event.request, res.clone()).catch(() => {}));
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  return cached || network;
}
