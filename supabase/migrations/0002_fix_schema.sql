-- M6 C3 修复：annotations 字段对齐本地 M4 + subscriptions 加 created_at + 删 trigger（恢复客户端 LWW）
-- 在 Supabase Dashboard > SQL Editor 粘贴运行（幂等）
-- 修复审查发现的 BUG 1（anno anchor jsonb -> text/start_offset/end_offset）/BUG 2（sub 缺 created_at）/BUG 5（trigger 破坏 LWW）

-- ===== annotations：drop anchor jsonb，加 text/start_offset/end_offset（对齐本地 M4 实现）=====
alter table public.annotations drop column if exists anchor;
alter table public.annotations add column if not exists text text not null default '';
alter table public.annotations add column if not exists start_offset int not null default 0;
alter table public.annotations add column if not exists end_offset int not null default 0;

-- ===== subscriptions：加 created_at（对齐本地 M5 实现）=====
alter table public.subscriptions add column if not exists created_at timestamptz not null default now();

-- ===== 删 touch_updated_at trigger（BUG 5）=====
-- trigger 在 UPDATE 时把 updated_at 改写为服务器 now()，破坏客户端 LWW 语义（应按编辑时间定胜负）；
-- 删后由客户端 dbPut 时设 updated_at = nowISO() 直达服务器，LWW 按编辑时间生效。
drop trigger if exists papers_touch on public.papers;
drop trigger if exists annotations_touch on public.annotations;
drop trigger if exists subscriptions_touch on public.subscriptions;
drop function if exists public.touch_updated_at();
