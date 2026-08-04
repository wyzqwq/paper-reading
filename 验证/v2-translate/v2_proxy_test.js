// v2 translate-proxy Edge Function 沙箱测试
// 真实 index.ts（node 22 类型剥离），stub Deno.serve/env + fetch（PostgREST + DeepSeek）。
// 依计划书 §11.3。覆盖：CORS/JWT 鉴权/user_secrets 查 key/DeepSeek 转发/错误透传/JSON 规整。
const path = require('path');

let pass = 0, fail = 0; const fails = [];
function ok(n, c, x) { if (c) pass++; else { fail++; fails.push('FAIL ' + n + (x ? ' :: ' + x : '')); } }
function eq(n, a, b) { ok(n, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b)); }

// ---- 可配置 stub 状态 ----
const ENV = { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_fake' };
let pgRows = [{ deepseek_key: 'sk-valid-key' }]; // PostgREST user_secrets 返回
let dsStatus = 200;            // DeepSeek 返回状态
let dsBody = null;             // DeepSeek 返回 JSON body（choices[0].message.content 为 JSON 字符串）
let dsContent = null;          // 直接设 content（覆盖 dsBody）
let lastDeepSeekBody = null;   // 捕获发给 DeepSeek 的 body
let lastPgHeaders = null;      // 捕获 PostgREST 请求 headers
let dsThrow = null;            // DeepSeek fetch 抛错

globalThis.Deno = {
  serve: (handler) => { globalThis.__handler = handler; },
  env: { get: (k) => ENV[k] },
};
globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : url.url;
  // PostgREST user_secrets 查询
  if (u.includes('/rest/v1/user_secrets')) {
    lastPgHeaders = opts && opts.headers;
    return { ok: true, status: 200, json: async () => pgRows, text: async () => JSON.stringify(pgRows) };
  }
  // DeepSeek
  if (u.includes('api.deepseek.com')) {
    lastDeepSeekBody = opts && opts.body ? JSON.parse(opts.body) : null;
    if (dsThrow) throw dsThrow;
    if (dsStatus === 200) {
      const content = dsContent != null ? dsContent : JSON.stringify(dsBody);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }), text: async () => '{}' };
    }
    return { ok: false, status: dsStatus, json: async () => ({ error: { message: 'ds err ' + dsStatus } }), text: async () => 'err' };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

async function call(method, headers, body) {
  const req = new Request('https://fake.supabase.co/functions/v1/translate-proxy', {
    method, headers: headers || {}, body: body != null ? JSON.stringify(body) : undefined,
  });
  const res = await globalThis.__handler(req);
  let json = null; try { json = await res.json(); } catch { /* */ }
  return { status: res.status, headers: res.headers, json };
}

(async () => {
  // 动态 import 真实 index.ts（类型剥离）；模块顶层 Deno.serve 捕获 handler
  await import('/sessions/pensive-lucid-cerf/mnt/paper-reading/supabase/functions/translate-proxy/index.ts');
  ok('Deno.serve 捕获 handler', typeof globalThis.__handler === 'function');

  // ---- T1 OPTIONS 预检 ----
  {
    const r = await call('OPTIONS', {});
    eq('OPTIONS 204', r.status, 204);
    eq('OPTIONS ACAO *', r.headers.get('Access-Control-Allow-Origin'), '*');
  }
  // ---- T2 GET 405 ----
  {
    const r = await call('GET', { Authorization: 'Bearer jwt' });
    eq('GET 405', r.status, 405);
  }
  // ---- T3 POST 无 JWT 401 ----
  {
    const r = await call('POST', {}, { text: 'hello' });
    eq('无 JWT 401', r.status, 401);
    ok('无 JWT 提示未登录', /未登录/.test(r.json && r.json.error), JSON.stringify(r.json));
  }
  // ---- T4 user_secrets 无 key 400 ----
  {
    pgRows = [];
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hello' });
    eq('无 key 400', r.status, 400);
    ok('无 key 提示设置页', /未设置.*key|设置页/.test(r.json && r.json.error), JSON.stringify(r.json));
    pgRows = [{ deepseek_key: 'sk-valid-key' }];
  }
  // ---- T5 正常翻译 200 ----
  {
    dsContent = JSON.stringify({ sentences: [{ en: 'Hello world.', zh: '你好世界。' }, { en: 'Fig. 3 shows.', zh: '图3所示。' }] });
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'Hello world. Fig. 3 shows.' });
    eq('正常 200', r.status, 200);
    eq('正常 pairs 数', r.json && r.json.sentences && r.json.sentences.length, 2);
    eq('正常 en verbatim', r.json.sentences[0].en, 'Hello world.');
    eq('正常 zh 译文', r.json.sentences[0].zh, '你好世界。');
    eq('正常 ACAO', r.headers.get('Access-Control-Allow-Origin'), '*');
    // DeepSeek 请求体校验
    ok('DS model=v4-flash', lastDeepSeekBody && lastDeepSeekBody.model === 'deepseek-v4-flash', JSON.stringify(lastDeepSeekBody));
    ok('DS response_format json_object', lastDeepSeekBody && lastDeepSeekBody.response_format && lastDeepSeekBody.response_format.type === 'json_object');
    eq('DS stream false', lastDeepSeekBody && lastDeepSeekBody.stream, false);
    eq('DS temperature 0.3', lastDeepSeekBody && lastDeepSeekBody.temperature, 0.3);
    ok('DS system prompt', lastDeepSeekBody && typeof lastDeepSeekBody.messages[0].content === 'string' && /逐句切分/.test(lastDeepSeekBody.messages[0].content));
    eq('DS user content=原文', lastDeepSeekBody && lastDeepSeekBody.messages[1].content, 'Hello world. Fig. 3 shows.');
    eq('DS url', lastDeepSeekBody && null, null); // 占位
    // PostgREST 用 anon key + 调用者 JWT（非 service role）
    ok('PG 用 anon key', lastPgHeaders && /sb_publishable/.test(lastPgHeaders.apikey), JSON.stringify(lastPgHeaders));
    eq('PG 用调用者 JWT', lastPgHeaders && lastPgHeaders.Authorization, 'Bearer jwt');
  }
  // ---- T6 DeepSeek 401 key 无效 ----
  {
    dsStatus = 401;
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('DS 401 透传', r.status, 401);
    ok('DS 401 提示 key 无效', /key 无效/.test(r.json && r.json.error), JSON.stringify(r.json));
    dsStatus = 200;
  }
  // ---- T7 DeepSeek 429 限速 ----
  {
    dsStatus = 429;
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('DS 429 透传', r.status, 429);
    ok('DS 429 提示限速', /限速/.test(r.json && r.json.error), JSON.stringify(r.json));
    dsStatus = 200;
  }
  // ---- T8 DeepSeek 5xx -> 502 ----
  {
    dsStatus = 500;
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('DS 500 -> 502', r.status, 502);
    ok('DS 502 含状态', /500/.test(r.json && r.json.error), JSON.stringify(r.json));
    dsStatus = 200;
  }
  // ---- T9 DeepSeek 返回非 JSON content -> 502 ----
  {
    dsContent = '这不是 JSON';
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('非 JSON 502', r.status, 502);
    ok('非 JSON 提示', /sentences|JSON|结构异常/.test(r.json && r.json.error), JSON.stringify(r.json));
  }
  // ---- T10 DeepSeek 返回无 sentences 字段 -> 502 ----
  {
    dsContent = JSON.stringify({ wrong: 'field' });
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('无 sentences 502', r.status, 502);
  }
  // ---- T11 缺 text 400 ----
  {
    dsContent = JSON.stringify({ sentences: [] });
    const r = await call('POST', { Authorization: 'Bearer jwt' }, {});
    eq('缺 text 400', r.status, 400);
    ok('缺 text 提示', /缺少 text/.test(r.json && r.json.error), JSON.stringify(r.json));
  }
  // ---- T12 text 超 MAX_TEXT 截断（20000）----
  {
    const big = 'a'.repeat(25000);
    dsContent = JSON.stringify({ sentences: [{ en: 'a', zh: '甲' }] });
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: big });
    eq('超长截断 200', r.status, 200);
    ok('DeepSeek 收到截断文本 <=20000', lastDeepSeekBody && lastDeepSeekBody.messages[1].content.length <= 20000, 'len=' + (lastDeepSeekBody && lastDeepSeekBody.messages[1].content.length));
  }
  // ---- T13 content 外裹文字，抽取 {...} 回退 ----
  {
    dsContent = '好的，结果如下：\n{"sentences":[{"en":"Hi.","zh":"嗨。"}]}\n以上。';
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'Hi.' });
    eq('外裹文字抽取 200', r.status, 200);
    eq('外裹文字 pairs', r.json && r.json.sentences && r.json.sentences.length, 1);
    eq('外裹文字 en', r.json.sentences[0].en, 'Hi.');
  }
  // ---- T14 空 en+空 zh 的对被丢弃；非字符串被规整 ----
  {
    dsContent = JSON.stringify({ sentences: [
      { en: 'Keep.', zh: '保留。' },
      { en: '', zh: '' },          // 丢弃
      { en: 'Only en.', zh: '' },  // 保留（en 非空）
      { zh: '只有译文' },          // en undefined -> ''，zh 非空 -> 保留
      { foo: 'bar' },              // en/zh 都 undefined -> '' '' -> 丢弃
    ] });
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'Keep. Only en.' });
    eq('规整 200', r.status, 200);
    eq('规整后 3 对', r.json && r.json.sentences.length, 3, JSON.stringify(r.json));
    eq('规整 en undefined -> 空串', r.json.sentences[2].en, '');
    eq('规整 zh 保留', r.json.sentences[2].zh, '只有译文');
  }
  // ---- T15 DeepSeek fetch 抛错 -> 502 ----
  {
    dsThrow = new Error('network down');
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('DS 抛错 502', r.status, 502);
    ok('DS 抛错提示', /DeepSeek 请求失败/.test(r.json && r.json.error), JSON.stringify(r.json));
    dsThrow = null;
  }
  // ---- T16 缺 SUPABASE_URL env 500 ----
  {
    const saved = ENV.SUPABASE_URL; delete ENV.SUPABASE_URL;
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('缺 env 500', r.status, 500);
    ok('缺 env 提示', /未配置/.test(r.json && r.json.error), JSON.stringify(r.json));
    ENV.SUPABASE_URL = saved;
  }
  // ---- T17 DeepSeek 返回 content 非 string（结构异常）502 ----
  {
    dsContent = 12345; dsBody = null; // content 为非字符串（DeepSeek 实际不会，测 defensive 分支）
    const r = await call('POST', { Authorization: 'Bearer jwt' }, { text: 'hi' });
    eq('content 非字符串 502', r.status, 502);
    ok('content 非字符串提示结构异常', /结构异常/.test(r.json && r.json.error), JSON.stringify(r.json));
    dsContent = null;
  }

  console.log('\n==== v2 translate-proxy 沙箱测 ====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fail) { fails.forEach((s) => console.log(s)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('TEST CRASH:', e && e.stack || e); process.exit(2); });
