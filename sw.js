// M1 Service Worker：缓存 app 壳。pdf.js/wasm/字体运行时缓存。
// P0：waiting 模式（install 不 skipWaiting，等页面 postMessage SKIP_WAITING 才接管），
// 配合"有新版本"横幅让用户决定何时刷新，不在阅读中途强制 reload 丢阅读现场。
// P0：导航 network-first（总拿新版，离线回缓存）；资源 cache-first + res.ok 守卫。
const CACHE = 'paper-reading-v24';
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
  // 不 skipWaiting：进入 waiting，等用户点"刷新"后页面 postMessage SKIP_WAITING 才接管
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// waiting 模式：页面发 SKIP_WAITING 才 skipWaiting 接管
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
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
  // 导航请求：network-first（总拿新版，避免 cache-first 永久卡旧版且无提示；
  // 离线/网络失败回缓存或 index.html）
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {}); }
        return res;
      } catch (err) {
        return (await caches.match(req)) || caches.match('./index.html');
      }
    })());
    return;
  }
  // 资源请求：cache-first + res.ok 守卫（不缓存 404 等）
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        // 离线回退：资源请求失败返回 404，别返回 HTML（否则 iOS 拿 HTML 当图标，Add to Home Screen 显示空白）
        return new Response('', { status: 404, statusText: 'Not Found' });
      })
    )
  );
});
