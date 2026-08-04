// M1 Service Worker：缓存 app 壳。pdf.js（M2 加入预缓存）；wasm/字体运行时缓存。
// 更新提示（"有更新，点击刷新"）留 M7。
const CACHE = 'paper-reading-v12';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 只管同源 GET；跨域（arXiv PDF / Supabase）不经过 SW 缓存策略
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        // 同源新资源顺带缓存（stale-while-revalidate 风格）
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
