// v2 翻译代理（Supabase Edge Function / Deno）
//
// 链路：浏览器(带 JWT) -> 本函数(verify_jwt=true,网关已验 JWT) ->
//   PostgREST user_secrets(用调用者 JWT + anon key,RLS 只读自己 key) ->
//   DeepSeek /chat/completions(JSON 模式) -> 返回逐句译文 [{en,zh},...]
//
// DeepSeek key 绝不前端持久化/进 git；用户在 app 设置页填,存 user_secrets 表(RLS)。
// 本函数用调用者 JWT 查自己的 key(非 service role key,见计划书 §11.3),再转发 DeepSeek。
//
// verify_jwt=true（见 supabase/config.toml）：Supabase 网关验过 JWT 才放行到本函数。
// 调用：POST .../translate-proxy   Body: {"text":"<页 textLayer 全文>"}   带 Authorization: Bearer <JWT>
// 返回：{"sentences":[{"en":"原句verbatim","zh":"译文"},...]}
//   错误：{"error":"..."} 配 400/401/429/502。
//
// DeepSeek API（2026-08-06 核对 api-docs.deepseek.com）：
//   base https://api.deepseek.com  endpoint /chat/completions  OpenAI 兼容
//   模型 deepseek-v4-flash(快/便宜,非推理)/ deepseek-v4-pro(重,带 thinking)
//   response_format {type:"json_object"} 支持；thinking/reasoning_effort 可选(翻译不开启,要快)
//   返回 choices[0].message.content(标准 OpenAI)；旧 deepseek-chat 已下线改 v4-*。

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Max-Age': '86400',
};

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash'; // 快/便宜档,翻译够用;非推理(不带 thinking)
const MAX_TEXT = 20000; // 单页 textLayer 文本上限,防单次调用过大/超 token
const TEMPERATURE = 0.3; // 译文稳定,低温度

const SYSTEM_PROMPT = [
  '你是一名英译中学术翻译。',
  '把用户给出的英文论文页文本逐句切分并翻译成中文,严格按 JSON 输出。',
  '要求:',
  '1. 输出 JSON 对象,格式 {"sentences":[{"en":"<原句英文 verbatim>","zh":"<中文译文>"},...]}。',
  '2. "en" 必须是原文逐字拷贝(verbatim),包括 "Fig. 3"、"et al."、引号等,不得改写、不得合并、不得拆分;前端按文本偏移定位,改写会匹配失败。',
  '3. 切句以句子语义边界为准(句号/问号/叹号/分号),不要按 "Fig."/"et al." 这类缩写误切。',
  '4. 数学公式、变量符号(如 x²、α、∇)、代码、URL、参考文献编号 原样保留不译,只译周围文字。',
  '5. 已是中文的片段跳过不译,en 照抄、zh 留原样或空。',
  '6. 句子间顺序与原文一致;不要增删句子;不要加任何解释/前言/后语,只输出 JSON。',
].join('\n');

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // verify_jwt=true 已由 Supabase 网关校验过 JWT;这里取调用者 JWT 转发查 PostgREST
  const auth = req.headers.get('Authorization') || '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!jwt) return json(401, { error: '未登录' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!supabaseUrl || !anonKey) {
    return json(500, { error: '服务端未配置 SUPABASE_URL/ANON_KEY' });
  }

  // 1. 用调用者 JWT 查自己的 DeepSeek key(RLS 只读自己那行;非 service role key)
  let deepseekKey = '';
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/user_secrets?select=deepseek_key`, {
      headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` },
    });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) deepseekKey = rows[0]?.deepseek_key || '';
    }
  } catch {
    // 查询失败按未设置处理
  }
  if (!deepseekKey) return json(400, { error: '未设置 DeepSeek key,请到设置页填写' });

  // 2. 读请求体文本
  let text = '';
  try {
    const body = await req.json();
    text = typeof body?.text === 'string' ? body.text : '';
  } catch {
    text = '';
  }
  if (!text) return json(400, { error: '缺少 text' });
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

  // 3. 调 DeepSeek,JSON 模式逐句翻译(不开 thinking,要快/省)
  let dsRes: Response;
  try {
    dsRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${deepseekKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
        response_format: { type: 'json_object' },
        stream: false,
        temperature: TEMPERATURE,
      }),
    });
  } catch (e) {
    return json(502, { error: 'DeepSeek 请求失败:' + String(e) });
  }

  // 4. 转发错误状态(401 无效 key / 429 限速 / 5xx)
  if (!dsRes.ok) {
    const code = dsRes.status;
    let msg = '';
    try {
      msg = (await dsRes.json())?.error?.message || '';
    } catch {
      /* ignore */
    }
    if (code === 401) return json(401, { error: 'DeepSeek key 无效,请到设置页检查' });
    if (code === 429) return json(429, { error: 'DeepSeek 限速,请稍后重试' });
    return json(502, { error: `DeepSeek ${code}:${msg || dsRes.statusText}` });
  }

  // 5. 解析返回 -> {sentences:[{en,zh},...]}
  let dsBody: any;
  try {
    dsBody = await dsRes.json();
  } catch {
    return json(502, { error: 'DeepSeek 返回非 JSON' });
  }
  const content = dsBody?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return json(502, { error: 'DeepSeek 返回结构异常' });

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    // 偶发:模型在 JSON 外裹了文字,尝试抽取首个 {...}
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        parsed = null;
      }
    }
  }
  const sentences = Array.isArray(parsed?.sentences) ? parsed.sentences : null;
  if (!sentences) return json(502, { error: 'DeepSeek 返回无 sentences 字段' });

  // 规整:只保留 {en,zh} 字符串对,丢弃空对
  const pairs = sentences
    .map((s: any) => ({
      en: typeof s?.en === 'string' ? s.en : '',
      zh: typeof s?.zh === 'string' ? s.zh : '',
    }))
    .filter((s: { en: string; zh: string }) => s.en || s.zh);

  return json(200, { sentences: pairs });
});
