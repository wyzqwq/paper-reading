-- v2 翻译功能：user_secrets（DeepSeek key）+ translations（逐页译文缓存）建表 + RLS
-- 在 Supabase Dashboard > SQL Editor 粘贴运行（幂等）
-- 依计划书 §11（2026-08-06 grill-me 对齐定稿）
-- 项目：hjrrocbisrgtxgqnflpi

-- ===== user_secrets：用户 DeepSeek API key（单行/用户，app 设置页填）=====
-- translate-proxy Edge Function 用调用者 JWT + anon key 经 PostgREST 读此表（RLS 只读自己的）
create table if not exists public.user_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  deepseek_key text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.user_secrets enable row level security;
drop policy if exists "user_secrets owner all" on public.user_secrets;
create policy "user_secrets owner all" on public.user_secrets
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== translations：逐页译文缓存（scope='page'，走 M6 同步：LWW + _dirty[本地] + tombstone）=====
create table if not exists public.translations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  paper_id uuid not null references public.papers(id) on delete cascade,
  scope text not null default 'page' check (scope in ('page')),
  page_num int not null,
  pairs jsonb not null default '[]',          -- [{en:原句verbatim, zh:译文}, ...]
  source_hash text not null default '',       -- 该页 textLayer 文本 SHA-256，文本变则失效重译
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists translations_paper_page_idx on public.translations(paper_id, page_num);
alter table public.translations enable row level security;
drop policy if exists "translations owner all" on public.translations;
create policy "translations owner all" on public.translations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 注：不加 touch_updated_at trigger（0002 已删；客户端 LWW 按 updated_at 定胜负，由 dbPut 时设 updated_at = nowISO() 直达服务器）。
