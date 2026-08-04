// v2 翻译真浏览器 e2e（chromium 130 + puppeteer-core + mock translate-proxy）
// 测试基建坑（非 app bug）：chromium 130 缺 Uint8Array.toHex（Chrome 133+ 才有），pdf.js v6 worker 用它。
// 修法：http server 对 /vendor/pdfjs/pdf.worker.min.mjs 返回 polyfill+真代码；主线程也 polyfill。
// 生产目标浏览器（iOS Safari 18.7 / 现代 Chrome）原生有 toHex，无此问题。
// 依计划书 §11.5/§11.6/§11.9/§11.10。harness §0.5：截图视觉 QA 走 haiku（本测先跑断言，截图另存）。
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = '/sessions/pensive-lucid-cerf/mnt/paper-reading';
const OUT = '/sessions/pensive-lucid-cerf/mnt/outputs';
const CHROME = OUT + '/chrome-extract/chrome-linux/chrome';
const PORT = 8110;

let pass = 0, fail = 0; const fails = [];
function ok(n, c, x) { if (c) pass++; else { fail++; fails.push('FAIL ' + n + (x ? ' :: ' + x : '')); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- toHex/fromHex/toBase64/fromBase64 polyfill（chromium 130 缺，pdf.js v6 worker 用）----
const POLY = `;(function(){
  if (typeof Uint8Array.prototype.toHex !== 'function') Object.defineProperty(Uint8Array.prototype,'toHex',{value:function(){let s='';for(let i=0;i<this.length;i++)s+=this[i].toString(16).padStart(2,'0');return s;},configurable:true,writable:true});
  if (typeof Uint8Array.fromHex !== 'function') Object.defineProperty(Uint8Array,'fromHex',{value:function(s){const o=new Uint8Array(s.length/2);for(let i=0;i<o.length;i++)o[i]=parseInt(s.substr(i*2,2),16);return o;},configurable:true,writable:true});
  if (typeof Uint8Array.prototype.toBase64 !== 'function') Object.defineProperty(Uint8Array.prototype,'toBase64',{value:function(){let b='';for(let i=0;i<this.length;i++)b+=String.fromCharCode(this[i]);return btoa(b);},configurable:true,writable:true});
  if (typeof Uint8Array.fromBase64 !== 'function') Object.defineProperty(Uint8Array,'fromBase64',{value:function(b){const s=atob(b);const o=new Uint8Array(s.length);for(let i=0;i<s.length;i++)o[i]=s.charCodeAt(i);return o;},configurable:true,writable:true});
})();`;
const REAL_WORKER = fs.readFileSync(path.join(REPO, 'vendor/pdfjs/pdf.worker.min.mjs'), 'utf8');
const POLY_WORKER = POLY + '\n' + REAL_WORKER;

// ---- mock translate-proxy 状态 ----
let proxyCalls = 0;
let lastProxyText = '';
let proxyMode = 'ok'; // 'ok' | 'err401'
function mockTranslate(text) {
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  return { sentences: lines.map((l, i) => ({ en: l, zh: '【译' + (i + 1) + '】' + l })) };
}

// ---- http server：直接读 REPO（无 symlink）；特殊路径 test.pdf(OUT) + worker(polyfill) ----
const CT = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.css':'text/css','.pdf':'application/pdf','.png':'image/png','.webmanifest':'application/manifest+json','.wasm':'application/wasm' };
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/test.pdf') { fs.readFile(OUT + '/test.pdf', (e, d) => { if (e) { res.writeHead(404); res.end('404'); return; } res.writeHead(200, { 'Content-Type':'application/pdf' }); res.end(d); }); return; }
  if (p === '/vendor/pdfjs/pdf.worker.min.mjs') { res.writeHead(200, { 'Content-Type':'text/javascript' }); res.end(POLY_WORKER); return; }
  fs.readFile(path.join(REPO, p), (e, d) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': CT[path.extname(p)] || 'application/octet-stream' });
    res.end(d);
  });
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const URL = `http://localhost:${PORT}/`;

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader-webgl','--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to load resource.*404|favicon|sw\.js|CORS|blocked by CORS/i.test(t)) errors.push(t); } });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

  // 主线程 polyfill + 预置登录态 + 禁 SW 注册（避免 SW 干扰 mock 请求；保留 container 供 addEventListener）
  await page.evaluateOnNewDocument(POLY + '\n' +
    'localStorage.setItem("sb_session", JSON.stringify({ access_token:"jwt-e2e", refresh_token:"rt", user:{id:"user-e2e"} }));\n' +
    'try { const sw = navigator.serviceWorker; if (sw) sw.register = async()=>({scope:"/",unregister:async()=>{},update:async()=>{}}); } catch(e){}');

  // 请求拦截：mock translate-proxy + supabase REST（含 OPTIONS 预检 CORS）；其余放行
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url(); const m = req.method();
    // translate-proxy Edge Function
    if (u.includes('/functions/v1/translate-proxy')) {
      if (m === 'OPTIONS') return req.respond({ status:204, headers:{ 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'*' } });
      if (m !== 'POST') return req.respond({ status:405, headers:{'Access-Control-Allow-Origin':'*'}, body:'{"error":"Method Not Allowed"}' });
      proxyCalls++;
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch { /* */ }
      lastProxyText = body.text || '';
      if (proxyMode === 'err401') return req.respond({ status:401, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'}, body:'{"error":"DeepSeek key 无效,请到设置页检查"}' });
      return req.respond({ status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'}, body: JSON.stringify(mockTranslate(lastProxyText)) });
    }
    // Supabase REST（syncPull/syncPush）
    if (u.includes('supabase.co/rest/v1/')) {
      if (m === 'OPTIONS') return req.respond({ status:204, headers:{ 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer,x-client-info','Access-Control-Max-Age':'86400' } });
      return req.respond({ status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'}, body:'[]' });
    }
    // Supabase auth
    if (u.includes('supabase.co/auth/')) {
      if (m === 'OPTIONS') return req.respond({ status:204, headers:{ 'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'authorization,apikey,content-type' } });
      return req.respond({ status:200, contentType:'application/json', headers:{'Access-Control-Allow-Origin':'*'}, body:'{}' });
    }
    req.continue();
  });

  await page.goto(URL, { waitUntil: 'networkidle2' });
  await sleep(600); // openDB + render + syncPull

  // 注入测试论文并打开阅读器
  await page.evaluate(async () => {
    await window.dbPut({ id:'p-e2e', title:'Test Paper', source_type:'url', url:'http://localhost:8110/test.pdf', status:'reading', added_at:new Date().toISOString(), updated_at:new Date().toISOString() });
    window.openReader({ id:'p-e2e', source_type:'url', url:'http://localhost:8110/test.pdf' });
  });
  await sleep(3500); // pdf.js worker + parse + layoutPages + page1 textLayer

  // ===== T1 阅读器开 + textLayer 渲染 =====
  const tl1 = await page.evaluate(() => {
    const rs = window.eval('readerState');
    const tl = rs && rs.textLayers && rs.textLayers[1];
    const container = tl && tl.container;
    return { hasTl: !!tl, spanCount: container ? container.querySelectorAll('span').length : 0, liveText: container ? container.textContent : '' };
  });
  ok('T1 阅读器 textLayer 存在', tl1.hasTl);
  ok('T1 textLayer span>0', tl1.spanCount > 0, 'spanCount=' + tl1.spanCount);
  ok('T1 textLayer 含 Hello world', /Hello world/.test(tl1.liveText), JSON.stringify(tl1.liveText));

  // ===== T2 开翻译开关 -> 预译循环 =====
  proxyCalls = 0;
  await page.click('#reader-translate-btn');
  await sleep(300);
  const statusTranslating = await page.evaluate(() => document.getElementById('reader-tr-status').textContent);
  ok('T2 翻译中状态显示', /翻译中|译文就绪/.test(statusTranslating), statusTranslating);
  await sleep(3000); // 等预译 2 页完成
  const statusDone = await page.evaluate(() => document.getElementById('reader-tr-status').textContent);
  ok('T2 译文就绪 2 页', /译文就绪\s*2\s*页/.test(statusDone), statusDone);
  ok('T2 调了 translate-proxy (>=2)', proxyCalls >= 2, 'proxyCalls=' + proxyCalls);

  // ===== T3 叠层：page1 有 tr-sent =====
  const overlay = await page.evaluate(() => {
    const rs = window.eval('readerState');
    const c = rs.textLayers[1].container;
    const sents = c.querySelectorAll('span.tr-sent');
    return { count: sents.length, firstPair: sents[0] && sents[0].dataset.pair, btnPressed: document.getElementById('reader-translate-btn').getAttribute('aria-pressed') };
  });
  ok('T3 page1 tr-sent 叠层>0', overlay.count > 0, 'count=' + overlay.count);
  ok('T3 翻译按钮 aria-pressed=true', overlay.btnPressed === 'true', 'pressed=' + overlay.btnPressed);
  ok('T3 tr-sent 有 data-pair', overlay.firstPair != null);

  // ===== T4 点句弹 ZH 浮层（dispatchEvent，避开 pdf.js span 绝对定位的点击坐标问题）=====
  await page.evaluate(() => {
    const rs = window.eval('readerState');
    const sent = rs.textLayers[1].container.querySelector('span.tr-sent');
    sent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(200);
  const popup = await page.evaluate(() => {
    const p = document.getElementById('reader-tr-popup');
    return { display: p.style.display, text: p.textContent, activeCount: document.querySelectorAll('span.tr-sent.tr-active').length };
  });
  ok('T4 ZH 浮层显示', popup.display === 'block', popup.display);
  ok('T4 ZH 浮层含译文', /【译/.test(popup.text), popup.text);
  ok('T4 点亮 tr-active', popup.activeCount >= 1, 'active=' + popup.activeCount);

  // ===== T5 M4 共存：有选区时点句不弹浮层 =====
  // 先清 T4 留下的浮层（onReaderTrClick 有选区时是 return，不主动清旧浮层）
  await page.evaluate(() => window.trHidePopup());
  await sleep(100);
  await page.evaluate(() => {
    const rs = window.eval('readerState');
    const c = rs.textLayers[1].container;
    const sent = c.querySelector('span.tr-sent');
    const other = c.querySelector('span:not(.tr-sent)');
    const sel = window.getSelection(); sel.removeAllRanges();
    if (other) { const r = document.createRange(); r.selectNode(other); sel.addRange(r); }
    // 选区非空时 dispatch click -> onReaderTrClick 应 return（让位 M4），不弹新浮层
    sent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await sleep(200);
  const popupWithSel = await page.evaluate(() => document.getElementById('reader-tr-popup').style.display);
  ok('T5 选区时点句不弹浮层', popupWithSel === 'none', popupWithSel);
  await page.evaluate(() => window.getSelection().removeAllRanges());

  // ===== T6 关阅读器：readerState 清空 + 无 pageerror =====
  await page.evaluate(() => window.closeReader());
  await sleep(400);
  const afterClose = await page.evaluate(() => ({ rsNull: window.eval('readerState') === null, trCancelled: window.eval('readerState && readerState.tr ? readerState.tr.cancelled : null') }));
  ok('T6 关阅读器 readerState=null', afterClose.rsNull, 'readerState=' + afterClose.rsNull);

  // ===== T7 重开 + 缓存命中零调用 =====
  await page.evaluate(() => window.openReader({ id:'p-e2e', source_type:'url', url:'http://localhost:8110/test.pdf' }));
  await sleep(3000);
  proxyCalls = 0;
  await page.click('#reader-translate-btn');
  await sleep(3000);
  ok('T7 缓存命中零调用', proxyCalls === 0, 'proxyCalls=' + proxyCalls);
  const overlay7 = await page.evaluate(() => { const rs = window.eval('readerState'); return rs.textLayers[1].container.querySelectorAll('span.tr-sent').length; });
  ok('T7 缓存叠层仍铺', overlay7 > 0, 'count=' + overlay7);

  // ===== T8 离线禁用 =====
  await page.evaluate(() => window.closeReader());
  await sleep(400);
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }));
  await page.evaluate(() => window.openReader({ id:'p-e2e', source_type:'url', url:'http://localhost:8110/test.pdf' }));
  await sleep(1500);
  await page.click('#reader-translate-btn');
  await sleep(500);
  const toastAfter = await page.evaluate(() => { const t = document.getElementById('toast'); return t ? t.textContent : ''; });
  ok('T8 离线 toast 提示联网', /翻译需联网/.test(toastAfter), 'toast=' + toastAfter);
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { get: () => true, configurable: true }));

  // ===== T9 错误路径：清缓存 + proxy 401 -> toast key 无效 + 停预译 =====
  await page.evaluate(() => window.closeReader());
  await sleep(400);
  await page.evaluate(async () => {
    const db = window.eval('db');
    const all = await window.rawGetAll('translations');
    for (const r of all) await new Promise((res) => { const t = db.transaction('translations', 'readwrite'); t.objectStore('translations').delete(r.id); t.oncomplete = () => res(); });
  });
  proxyMode = 'err401';
  proxyCalls = 0;
  await page.evaluate(() => window.openReader({ id:'p-e2e', source_type:'url', url:'http://localhost:8110/test.pdf' }));
  await sleep(1500);
  await page.click('#reader-translate-btn');
  await sleep(2000);
  const t9 = await page.evaluate(() => {
    const t = document.getElementById('toast');
    const tr = window.eval('readerState && readerState.tr');
    return { toast: t ? t.textContent : '', p1Status: tr && tr.pages[1] && tr.pages[1].status, p2: tr && tr.pages[2] };
  });
  ok('T9 401 toast key 无效', /key 无效|设置页/.test(t9.toast), 'toast=' + t9.toast);
  ok('T9 page1 标记 error', t9.p1Status === 'error', 'p1=' + t9.p1Status);
  ok('T9 停预译 page2 未译', !t9.p2 || !t9.p2.ready, 'p2=' + JSON.stringify(t9.p2));
  // sbFetch 遇 401 会刷新重试一次 -> page1 最多 2 次调用；循环 break 不触 page2（若触 page2 会 3-4 次）
  ok('T9 循环停在 page1（proxyCalls<=2）', proxyCalls >= 1 && proxyCalls <= 2, 'proxyCalls=' + proxyCalls);
  proxyMode = 'ok';

  // ===== 无 JS 错误 =====
  ok('无 pageerror / 非 CORS console error', errors.filter((e) => !/favicon|sw\.js|Failed to load resource|CORS/i.test(e)).length === 0, JSON.stringify(errors));

  // 截图存档（haiku 视觉 QA 用）
  await page.evaluate(() => window.closeReader());
  await sleep(300);
  await page.evaluate(() => window.openReader({ id:'p-e2e', source_type:'url', url:'http://localhost:8110/test.pdf' }));
  await sleep(2500);
  await page.click('#reader-translate-btn');
  await sleep(3000);
  await page.evaluate(() => { const rs = window.eval('readerState'); const sent = rs.textLayers[1].container.querySelector('span.tr-sent'); if (sent) sent.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await sleep(300);
  await page.screenshot({ path: OUT + '/shots/v2-translate.png' });

  console.log('\n==== v2 真浏览器 e2e ====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fail) fails.forEach((s) => console.log(s));
  if (errors.length) console.log('errors:', errors);

  await browser.close();
  server.close();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('TEST CRASH:', e && e.stack || e);
  try { server.close(); } catch { /* */ }
  process.exit(2);
});
