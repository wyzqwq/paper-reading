// arXiv API 代理（Supabase Edge Function / Deno）
//
// 原因：export.arxiv.org 不发 Access-Control-Allow-Origin，浏览器直连被 CORS 阻（M0 实测）。
// 本函数服务端转发 arXiv API 并加 CORS *，供前端 M3 导入 / M5 日推调用。
// verify_jwt = false（见 supabase/config.toml）：arXiv API 本就公开，无需鉴权。
//
// 调用：GET https://<project>.supabase.co/functions/v1/arxiv-proxy?id_list=<arxiv-id>
// 返回：application/atom+xml（arXiv 原样）。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  const u = new URL(req.url);
  const idList = u.searchParams.get('id_list') || '';
  if (!idList) {
    return new Response(JSON.stringify({ error: 'missing id_list' }), {
      status: 400,
      headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  // arXiv 礼貌使用：User-Agent 带应用名；建议部署后改成你的邮箱（arXiv 推荐）。
  const apiUrl =
    'https://export.arxiv.org/api/query?id_list=' +
    encodeURIComponent(idList) +
    '&max_results=1';
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
