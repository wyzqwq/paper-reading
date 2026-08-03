-- M6 同步：建表 + RLS + Storage bucket（在 Supabase Dashboard > SQL Editor 粘贴运行）
-- 幂等：可重复运行（if not exists / on conflict / drop policy if exists / drop trigger if exists）
-- 项目：hjrrocbisrgtxgqnflpi

-- ===== 1. papers（§4.1） =====
create table if not exists public.papers (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  authors text[] not null default '{}',
  abstract text,
  source_type text not null check (source_type in ('arxiv','local','url','manual')),
  arxiv_id text,
  url text,
  local_file_path text,
  status text not null check (status in ('want','reading','done','abandoned')),
  rating int check (rating is null or rating between 1 and 5),
  tags text[] not null default '{}',
  notes_md text not null default '',
  read_progress float not null default 0,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ===== 2. annotations（§4.2） =====
create table if not exists public.annotations (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  paper_id uuid not null references public.papers(id) on delete cascade,
  page int not null,
  anchor jsonb not null,
  color text not null default '',
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists annotations_paper_id_idx on public.annotations(paper_id);

-- ===== 3. subscriptions（§4.3） =====
create table if not exists public.subscriptions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  keywords jsonb not null default '[]',
  categories text[] not null default '{}',
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ===== 4. dismissed（§4.4） =====
create table if not exists public.dismissed (
  user_id uuid not null references auth.users(id) on delete cascade,
  arxiv_id text not null,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, arxiv_id)
);

-- ===== RLS：单用户但每表仍按 user_id = auth.uid() 隔离 =====
alter table public.papers enable row level security;
alter table public.annotations enable row level security;
alter table public.subscriptions enable row level security;
alter table public.dismissed enable row level security;

create policy "papers owner all" on public.papers
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "annotations owner all" on public.annotations
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "subscriptions owner all" on public.subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "dismissed owner all" on public.dismissed
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===== updated_at 自动更新触发器（push 时 upsert 不必手动设） =====
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists papers_touch on public.papers;
create trigger papers_touch before update on public.papers
  for each row execute function public.touch_updated_at();
drop trigger if exists annotations_touch on public.annotations;
create trigger annotations_touch before update on public.annotations
  for each row execute function public.touch_updated_at();
drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- ===== Storage bucket：本地 PDF（私有；arXiv/url 不上传） =====
insert into storage.buckets (id, name, public) values ('pdfs', 'pdfs', false)
  on conflict (id) do nothing;

-- Storage RLS：路径前缀 <user_id>/ 下对象只允许 owner 读写删
drop policy if exists "pdfs owner read" on storage.objects;
create policy "pdfs owner read" on storage.objects
  for select using (bucket_id = 'pdfs' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists "pdfs owner insert" on storage.objects;
create policy "pdfs owner insert" on storage.objects
  for insert with check (bucket_id = 'pdfs' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists "pdfs owner update" on storage.objects;
create policy "pdfs owner update" on storage.objects
  for update using (bucket_id = 'pdfs' and split_part(name, '/', 1) = auth.uid()::text);
drop policy if exists "pdfs owner delete" on storage.objects;
create policy "pdfs owner delete" on storage.objects
  for delete using (bucket_id = 'pdfs' and split_part(name, '/', 1) = auth.uid()::text);
