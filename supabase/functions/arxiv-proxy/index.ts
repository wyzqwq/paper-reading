// arXiv API 代理（Supabase Edge Function / Deno）
//
// 原因：export.arxiv.org 不发 Access-Control-Allow-Origin，浏览器直连被 CORS 阻（M0 实测）。
// 本函数服务端转发 arXiv API 并加 CORS *，供前端 M3 导入 / M5 日推调用。
// verify_jwt = false（见 supabase/config.toml）：arXiv API 本就公开，无需鉴权。
//
// 调用（M3 导入，按 ID）：
//   GET .../arxiv-proxy?id_list=<arxiv-id>
// 调用（M5 日推，按分类搜最新）：
//   GET .../arxiv-proxy?search_query=<cat:cs.CL OR cat:cs.LG>&max_results=100&sortBy=submittedDate&sortOrder=descending
//   search_query 由 app 端拼（M5 软出现：只按分类拉，关键词降为 app 端打分信号，不进 search_query）。
//   max_results 软上限 200（防滥用，app 端用 100）。
// 返回：application/atom+xml（arXiv 原样），app 端 parseArxivXml 解析。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const MAX_RESULTS_CAP = 200;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  const u = new URL(req.url);
  const idList = u.searchParams.get('id_list') || '';
  const searchQuery = u.searchParams.get('search_query') || '';
  const maxResultsRaw = u.searchParams.get('max_results') || '';
  const sortBy = u.searchParams.get('sortBy') || '';
  const sortOrder = u.searchParams.get('sortOrder') || '';

  const params = new URLSearchParams();
  if (searchQuery) {
    // M5 搜索模式：按分类拉最新投稿
    params.set('search_query', searchQuery);
    let n = parseInt(maxResultsRaw, 10);
    if (!Number.isFinite(n) || n <= 0) n = 50;
    if (n > MAX_RESULTS_CAP) n = MAX_RESULTS_CAP;
    params.set('max_results', String(n));
    if (sortBy) params.set('sortBy', sortBy);
    if (sortOrder) params.set('sortOrder', sortOrder);
  } else if (idList) {
    // M3 导入模式：按 ID 拉单篇
    params.set('id_list', idList);
    params.set('max_results', '1');
  } else {
    return new Response(JSON.stringify({ error: 'missing id_list or search_query' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  // arXiv 礼貌使用：User-Agent 带应用名；建议部署后改成你的邮箱（arXiv 推荐）。
  const apiUrl = 'https://export.arxiv.org/api/query?' + params.toString();
  try {
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'paper-reading-app/1.0' },
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        ...CORS,
        'Content-Type': 'application/atom+xml; charset=utf-8',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 502,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
});
