const CACHE = 'boveda-plus-v1';
const APP_SHELL = ['/boot.js', '/manifest.webmanifest', '/icon.svg', '/plantillas/Plantilla-importacion-Boveda-Plus.xlsx'];

async function installShell() {
  const cache = await caches.open(CACHE);
  const documentResponse = await fetch('/index.html', { cache: 'no-store' });
  if (!documentResponse.ok) throw new Error('No se pudo descargar Bóveda Plus');
  const html = await documentResponse.clone().text();
  // Activate only after the exact scripts and styles for this HTML are cached.
  const assets = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]);
  if (!assets.some((asset) => asset.endsWith('.js'))) throw new Error('Compilación incompleta');
  for (const url of [...new Set([...APP_SHELL, ...assets])]) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok || (url.endsWith('.js') && !/javascript/.test(response.headers.get('content-type') || ''))) {
      throw new Error(`No se pudo descargar ${url}`);
    }
    await cache.put(url, response);
  }
  // Cloudflare redirects /index.html to /. Cached redirected responses cannot
  // satisfy a navigation whose redirect mode is manual (net::ERR_FAILED).
  const documentBody = await documentResponse.arrayBuffer();
  const cachedDocument = new Response(documentBody, {
    status: documentResponse.status,
    statusText: documentResponse.statusText,
    headers: documentResponse.headers,
  });
  await cache.put('/', cachedDocument.clone());
  await cache.put('/index.html', cachedDocument);
  await self.skipWaiting();
}

self.addEventListener('install', (event) => event.waitUntil(installShell()));

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key.startsWith('boveda-') && key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname === '/sw.js') return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Keep HTML and its assets on the same completely installed build.
    const cached = await cache.match(event.request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok && !response.headers.get('content-type')?.includes('text/html')) {
      await cache.put(event.request, response.clone());
    }
    return response;
  })());
});
