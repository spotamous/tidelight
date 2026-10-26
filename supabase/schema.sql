-- Tidelight: sign-in and sync setup.
-- Paste this whole file into Supabase → SQL Editor → New query, then click Run.
-- Safe to run more than once.

-- 1. One private row of app data per signed-in user (spots, plans, keepers, synced settings).
create table if not exists public.user_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_state enable row level security;

drop policy if exists "Users read their own state"   on public.user_state;
drop policy if exists "Users insert their own state" on public.user_state;
drop policy if exists "Users update their own state" on public.user_state;
drop policy if exists "Users delete their own state" on public.user_state;

create policy "Users read their own state"   on public.user_state for select to authenticated using (auth.uid() = user_id);
create policy "Users insert their own state" on public.user_state for insert to authenticated with check (auth.uid() = user_id);
create policy "Users update their own state" on public.user_state for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users delete their own state" on public.user_state for delete to authenticated using (auth.uid() = user_id);

-- 2. A private bucket for spot photos. Each user can only touch files in a folder named after their user id.
insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "Users read their own photos"   on storage.objects;
drop policy if exists "Users upload their own photos" on storage.objects;
drop policy if exists "Users update their own photos" on storage.objects;
drop policy if exists "Users delete their own photos" on storage.objects;

create policy "Users read their own photos" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users upload their own photos" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users update their own photos" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "Users delete their own photos" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text);
