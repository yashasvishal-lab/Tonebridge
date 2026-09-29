/* Tonebridge service worker - offline after the first visit.
 *
 * No build-time hash list on purpose: the app is a single-page bundle that may be served
 * from any subdirectory, so the cache is filled as the page actually loads (stale-while-
 * revalidate for the shell, cache-first for immutable assets). Everything is same-origin;
 * nothing here can reach a network other than the one serving the app.
 */

const SHELL = 'tonebridge-shell-v1';
const ASSETS = 'tonebridge-assets-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(['./', './index.html', './manifest.webmanifest', './capture-worklet.js']))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const immutable = (pathname) => /\/assets\/.+-[\w-]{6,}\.(js|css|png|svg|woff2)$/.test(pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never proxy anywhere else

  if (immutable(url.pathname)) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Navigations and the shell: network first, cache when offline.
  event.respondWith(
    fetch(req)
      .then(async (res) => {
        if (res && res.ok) {
          const cache = await caches.open(SHELL);
          cache.put(req, res.clone());
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const shell = await caches.match('./index.html');
          if (shell) return shell;
        }
        return new Response('offline', { status: 503, statusText: 'offline' });
      }),
  );
});
