// v2 翻译：jsdom + fake-indexeddb 单测（纯逻辑 + 数据层 + sync payload）
// 整脚本载入真实 index.html，beforeParse 注入 fake-indexeddb + webcrypto + fetch stub。
// 依计划书 §11.4/§11.6。harness §0.5：本测无图像，主模型可直跑。
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const fakeIndexedDB = require('fake-indexeddb').indexedDB;

const REPO = '/sessions/pensive-lucid-cerf/mnt/paper-reading';
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

let pass = 0, fail = 0;
const asserts = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; asserts.push('FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function eq(name, a, b) {
  const cond = JSON.stringify(a) === JSON.stringify(b);
  ok(name, cond, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));
}

// ---- 捕获 fetch 请求（syncPush 测试用）----
const fetchLog = [];
function makeFetchStub() {
  return async (url, opts) => {
    fetchLog.push({ url, opts });
    // translations / user_secrets upsert 成功
    return {
      ok: true, status: 200,
      json: async () => ([]),
      text: async () => 'ok',
    };
  };
}

const dom = new JSDOM(html, {
  url: 'http://localhost:8080/', // 非 opaque origin，localStorage 可用
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(window) {
    window.indexedDB = fakeIndexedDB;
    // jsdom window.crypto 无 subtle，强制覆盖为 node webcrypto（sha256Hex 用 subtle.digest）
    Object.defineProperty(window, 'crypto', { value: globalThis.crypto, writable: true, configurable: true });
    window.fetch = makeFetchStub();
    // localStorage jsdom 自带
  },
});
const w = dom.window;

// 等待 openDB + render 完成
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await sleep(200); // openDB + render + v5 cursor 迁移
  // db/readerState 是 let（词法），用 eval 读
  if (!w.eval('!!db')) { console.error('FATAL: openDB 未完成（db 为空）'); process.exit(1); }

  // ===================== 1. sha256Hex =====================
  {
    const h = await w.sha256Hex('hello');
    eq('sha256Hex hello', h, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    const h2 = await w.sha256Hex('');
    eq('sha256Hex empty', h2, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    ok('sha256Hex 长度64', (await w.sha256Hex('论文翻译')).length === 64);
  }

  // ===================== 2. trFindOffset 三级匹配 =====================
  // 构造一个 map（模拟 trBuildTextMap 输出）：raw=live 文本（无 \n）
  {
    const raw = 'Hello world. Fig. 3 shows the result. We use transformers.';
    // norm 与 raw 相同（单空格），rawStart[i]=i
    const rawStart = raw.split('').map((_, i) => i);
    const map = { raw, norm: raw.replace(/\s+/g, ' ').trim(), rawStart };

    // 2a. 原样命中
    let f = w.trFindOffset(map, 'Hello world.', 0);
    eq('trFind 原样 start', f && f.start, 0);
    eq('trFind 原样 end', f && f.end, 12);

    // 2b. fromPos 推进：第二句从 13 起
    f = w.trFindOffset(map, 'Fig. 3 shows the result.', 13);
    eq('trFind 第二句 start', f && f.start, 13);
    eq('trFind 第二句 end', f && f.end, 37); // "Fig. 3 shows the result." 24 字符，13+24=37

    // 2c. 去 \n 命中：en 含 \n（LLM 跨行句），live 无 \n
    const raw2 = 'AAABBBCCC'; // live 无换行
    const map2 = { raw: raw2, norm: raw2, rawStart: raw2.split('').map((_, i) => i) };
    f = w.trFindOffset(map2, 'AAA\nBBB', 0); // en 带 \n
    eq('trFind 去换行 start', f && f.start, 0);
    eq('trFind 去换行 end', f && f.end, 6); // enNonl 长度 6

    // 2d. 归一化空白匹配：raw 多空格，en 单空格
    const raw3 = 'foo   bar baz'; // 多空格
    const norm3 = 'foo bar baz';
    // rawStart: f=0,o=1,o=2, (ws)=3, (ws)->单空格 rawStart[3]=3, b=6,a=7,r=8, (sp)=9, b=10,a=11,z=12
    // 手算 norm: 'foo bar baz', rawStart=[0,1,2,3,6,7,8,9,10,11,12]
    const rs3 = [0, 1, 2, 3, 6, 7, 8, 9, 10, 11, 12];
    const map3 = { raw: raw3, norm: norm3, rawStart: rs3 };
    f = w.trFindOffset(map3, 'foo bar', 0); // enNorm='foo bar'
    eq('trFind 归一化 start', f && f.start, 0);
    eq('trFind 归一化 end', f && f.end, 9); // raw 'foo   bar' 占 [0,9)，end=9

    // 2e. 无匹配返回 null
    f = w.trFindOffset(map, '不存在的句子', 0);
    eq('trFind 无匹配 null', f, null);

    // 2f. 空 en 返回 null
    f = w.trFindOffset(map, '', 0);
    eq('trFind 空 en null', f, null);
  }

  // ===================== 3. trWrapSentence + trUnwrapPage（跨 span）=====================
  {
    // 造一个 textLayer 容器，内含多个 span（模拟 pdf.js textDivs）
    const container = w.document.createElement('div');
    container.className = 'textLayer';
    const s1 = w.document.createElement('span'); s1.textContent = 'Hello world. '; // 13
    const s2 = w.document.createElement('span'); s2.textContent = 'Fig. 3 shows.';   // 13
    container.appendChild(s1); container.appendChild(s2);

    // 3a. 单 span 内包一句
    let any = w.trWrapSentence(container, 0, 12, 0); // 'Hello world.'
    ok('wrap 单 span 成功', any);
    const marks0 = container.querySelectorAll('span.tr-sent');
    ok('wrap 单 span 1 个 mark', marks0.length === 1, 'got ' + marks0.length);
    eq('wrap data-pair', marks0[0].dataset.pair, '0');
    eq('wrap 文本', marks0[0].textContent, 'Hello world.');
    // 父节点是 span（继承 --font-height）
    ok('wrap mark 在 span 内', marks0[0].parentNode === s1);

    // 3b. 跨 span 包一句（surroundContents 跨节点失败 -> extractContents 回退）
    w.trUnwrapPage(container);
    // 跨 span：[6, 20) -> s1 的 'world. '(6-12) + s2 的 'Fig. 3'(13-19)
    any = w.trWrapSentence(container, 6, 20, 1);
    ok('wrap 跨 span 成功', any);
    const marks1 = container.querySelectorAll('span.tr-sent');
    ok('wrap 跨 span 2 个 mark', marks1.length === 2, 'got ' + marks1.length);
    eq('wrap 跨 span 文本拼接', marks1[0].textContent + marks1[1].textContent, 'world. Fig. 3 '); // [6,20) 含尾空格
    // 两个 mark 共享 data-pair=1
    ok('wrap 跨 span 共享 pair', marks1[0].dataset.pair === '1' && marks1[1].dataset.pair === '1');
    // 各自留在原 span 内
    ok('wrap 跨 span mark0 在 s1', marks1[0].parentNode === s1);
    ok('wrap 跨 span mark1 在 s2', marks1[1].parentNode === s2);

    // 3c. unwrap 还原文本
    w.trUnwrapPage(container);
    const marks2 = container.querySelectorAll('span.tr-sent');
    ok('unwrap 后 0 mark', marks2.length === 0);
    // 容器纯文本不变（拼接顺序保留）
    const walker = w.document.createTreeWalker(container, w.window.NodeFilter.SHOW_TEXT);
    let txt = ''; while (walker.nextNode()) txt += walker.currentNode.nodeValue;
    eq('unwrap 文本还原', txt, 'Hello world. Fig. 3 shows.');

    // 3d. end<=start 不包
    ok('wrap end<=start false', w.trWrapSentence(container, 5, 5, 9) === false);
  }

  // ===================== 4. 数据层（translations / user_secrets）=====================
  {
    const pid = 'paper-uuid-1';
    const uid = w.uid();
    // dbPutTranslation 新增
    await w.dbPutTranslation({ id: uid, user_id: 'u1', paper_id: pid, page_num: 1, pairs: [{ en: 'A.', zh: '甲。' }], source_hash: 'h1' });
    let row = await w.dbGetTranslation(pid, 1);
    ok('dbPut 新增+dbGet', !!row && row.pairs[0].zh === '甲。');
    ok('dbPut _dirty=true', row._dirty === true);
    ok('dbPut scope=page', row.scope === 'page');
    ok('dbPut updated_at 有', !!row.updated_at);

    // 同 paper+page 复用 id 更新（source_hash 变则重译覆盖）
    await w.dbPutTranslation({ id: uid, user_id: 'u1', paper_id: pid, page_num: 1, pairs: [{ en: 'A.', zh: '甲（新）。' }], source_hash: 'h2' });
    row = await w.dbGetTranslation(pid, 1);
    eq('dbPut 复用 id 更新 pairs', row.pairs[0].zh, '甲（新）。');
    eq('dbPut 复用 id 更新 hash', row.source_hash, 'h2');

    // 同 paper 另一页
    await w.dbPutTranslation({ id: w.uid(), user_id: 'u1', paper_id: pid, page_num: 2, pairs: [{ en: 'B.', zh: '乙。' }], source_hash: 'h2p2' });

    // dbGetAllTranslations：按 page 去重取最新
    let all = await w.dbGetAllTranslations(pid);
    ok('dbGetAll 2 页', all.length === 2, 'got ' + all.length);

    // 多行同 page：取未删最新
    const oldT = '2026-01-01T00:00:00.000Z';
    const newT = '2026-06-01T00:00:00.000Z';
    await w.rawPut('translations', { id: 'old-row', user_id: 'u1', paper_id: pid, page_num: 3, pairs: [{ en: 'old', zh: '旧' }], source_hash: 'h3', updated_at: oldT, _dirty: false });
    await w.rawPut('translations', { id: 'new-row', user_id: 'u1', paper_id: pid, page_num: 3, pairs: [{ en: 'new', zh: '新' }], source_hash: 'h3', updated_at: newT, _dirty: false });
    row = await w.dbGetTranslation(pid, 3);
    eq('dbGet 同 page 多行取最新', row.id, 'new-row');

    // 软删过滤
    await w.rawPut('translations', { id: 'del-row', user_id: 'u1', paper_id: pid, page_num: 4, pairs: [{ en: 'del', zh: '删' }], source_hash: 'h4', updated_at: newT, deleted_at: '2026-06-02T00:00:00.000Z', _dirty: false });
    row = await w.dbGetTranslation(pid, 4);
    eq('dbGet 过滤软删', row, null);
    all = await w.dbGetAllTranslations(pid);
    ok('dbGetAll 过滤软删', !all.find((r) => r.id === 'del-row'));

    // user_secrets
    await w.dbPutSecret({ user_id: 'u1', deepseek_key: 'sk-test-123' });
    let sec = await w.dbGetSecret('u1');
    eq('dbPutSecret+dbGetSecret', sec.deepseek_key, 'sk-test-123');
    ok('dbPutSecret _dirty=true', sec._dirty === true);
    // 更新
    await w.dbPutSecret({ user_id: 'u1', deepseek_key: 'sk-new-456' });
    sec = await w.dbGetSecret('u1');
    eq('dbPutSecret 更新', sec.deepseek_key, 'sk-new-456');
  }

  // ===================== 5. syncPush payload 构造 =====================
  {
    fetchLog.length = 0;
    // 伪造登录态
    w.localStorage.setItem('sb_session', JSON.stringify({ access_token: 'jwt-test', refresh_token: 'rt', user: { id: 'user-uuid-1' } }));
    // 先把 section 4 残留的 dirty 行标记为已同步（rawPut 强制 _dirty=false），隔离本节
    const allTr = await w.rawGetAll('translations');
    for (const r of allTr) await w.rawPut('translations', r);
    const allSec = await w.rawGetAll('user_secrets');
    for (const r of allSec) await w.rawPut('user_secrets', r);

    // 用 dbPutTranslation/dbPutSecret 创建 dirty 行（它们置 _dirty=true）；rawPut 置 false 不能用来造 dirty
    await w.dbPutTranslation({ id: 'tr-sync-1', user_id: 'user-uuid-1', paper_id: 'p-sync', page_num: 1, pairs: [{ en: 'X.', zh: 'X。' }], source_hash: 'hs' });
    await w.dbPutSecret({ user_id: 'user-uuid-1', deepseek_key: 'sk-sync' });
    // 一条非 dirty 的不应被推（rawPut 置 _dirty=false）
    await w.rawPut('translations', { id: 'tr-clean', user_id: 'user-uuid-1', paper_id: 'p-sync', page_num: 2, pairs: [], source_hash: 'hc', updated_at: '2026-08-06T00:00:00.000Z' });

    // 取消 section 4/5 dbPut 排队的 schedulePush 定时器，免得干扰
    await w.syncPush();

    // 找 translations 与 user_secrets 请求
    const trReq = fetchLog.find((f) => f.url.includes('/rest/v1/translations?'));
    const secReq = fetchLog.find((f) => f.url.includes('/rest/v1/user_secrets?'));
    ok('syncPush 发 translations 请求', !!trReq);
    ok('syncPush 发 user_secrets 请求', !!secReq);

    // translations: on_conflict=id
    ok('translations on_conflict=id', trReq && trReq.url.includes('on_conflict=id'), trReq && trReq.url);
    const trPayload = trReq ? JSON.parse(trReq.opts.body) : [];
    // 只含 dirty 行（tr-sync-1），不含 tr-clean
    ok('translations payload 只含 dirty', trPayload.length === 1 && trPayload[0].id === 'tr-sync-1', JSON.stringify(trPayload));
    ok('translations _dirty 已删', trPayload[0] && trPayload[0]._dirty === undefined);
    eq('translations user_id 注入', trPayload[0] && trPayload[0].user_id, 'user-uuid-1');
    eq('translations deleted_at=null', trPayload[0] && trPayload[0].deleted_at, null);
    ok('translations Prefer merge-duplicates', trReq && trReq.opts.headers && trReq.opts.headers.Prefer === 'resolution=merge-duplicates');

    // user_secrets: on_conflict=user_id，无 deleted_at 字段
    ok('user_secrets on_conflict=user_id', secReq && secReq.url.includes('on_conflict=user_id'), secReq && secReq.url);
    const secPayload = secReq ? JSON.parse(secReq.opts.body) : [];
    ok('user_secrets payload 1 行', secPayload.length === 1);
    eq('user_secrets deepseek_key', secPayload[0] && secPayload[0].deepseek_key, 'sk-sync');
    ok('user_secrets 无 deleted_at', secPayload[0] && secPayload[0].deleted_at === undefined);
    ok('user_secrets _dirty 已删', secPayload[0] && secPayload[0]._dirty === undefined);

    // 推送成功后 _dirty=false
    const trAfter = await w.rawGet('translations', 'tr-sync-1');
    ok('translations 推后 _dirty=false', trAfter._dirty === false);
    const secAfter = await w.rawGet('user_secrets', 'user-uuid-1');
    ok('user_secrets 推后 _dirty=false', secAfter._dirty === false);
  }

  // ===================== 汇总 =====================
  console.log('\n==== v2 jsdom 单测 ====');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (fail) { asserts.forEach((s) => console.log(s)); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error('TEST CRASH:', e && e.stack || e); process.exit(2); });
