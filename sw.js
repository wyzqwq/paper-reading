// M1 Service Worker：缓存 app 壳。pdf.js（M2 加入预缓存）；wasm/字体运行时缓存。
// 更新提示（"有更新，点击刷新"）留 M7。
const CACHE = 'paper-reading-v23';
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
  // M8：iOS Safari「添加到主屏」用 manifest 图标，但把相对路径解析到域名根，
  // 子路径部署（/<repo>/）下根路径无图标会 404。拦截 manifest 请求，把图标 src
  // 改成基于 manifest URL 的绝对路径（/paper-reading/icons/... 或 /icons/...）。
  // 保持 manifest URL 为真实同源 URL（不用 blob），iOS 才认 PWA。
  if (url.pathname.endsWith('/manifest.webmanifest')) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        const m = await res.json();
        const base = url.pathname.replace(/[^/]*$/, ''); // manifest 所在目录
        if (Array.isArray(m.icons)) {
          m.icons = m.icons.map((ic) => {
            if (!ic || typeof ic.src !== 'string') return ic;
            return { ...ic, src: base + ic.src.replace(/^\.?\//, '') };
          });
        }
        return new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/manifest+json' } });
      } catch (err) {
        return fetch(req);
      }
    })());
    return;
  }
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        // 同源新资源顺带缓存（stale-while-revalidate 风格）
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => {
        // 离线回退：仅导航请求（HTML 页面）回 index.html；资源请求（图标等）失败返回 404，
        // 别返回 HTML（否则 iOS 拿到 HTML 当图标，Add to Home Screen 显示空白）
        if (req.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 404, statusText: 'Not Found' });
      })
    )
  );
});
