-- Tidelight alerts setup. Run in Supabase → SQL Editor → New query, AFTER schema.sql.
-- Safe to run more than once.

-- 1. Devices that receive alerts (one row per phone/browser that turned alerts on).
create table if not exists public.push_subscriptions (
  id           bigserial primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  endpoint     text not null unique,
  subscription jsonb not null,
  created_at   timestamptz not null default now()
);
alter table public.push_subscriptions enable row level security;
drop policy if exists "Users read their own devices"   on public.push_subscriptions;
drop policy if exists "Users add their own devices"    on public.push_subscriptions;
drop policy if exists "Users update their own devices" on public.push_subscriptions;
drop policy if exists "Users remove their own devices" on public.push_subscriptions;
create policy "Users read their own devices"   on public.push_subscriptions for select to authenticated using (auth.uid() = user_id);
create policy "Users add their own devices"    on public.push_subscriptions for insert to authenticated with check (auth.uid() = user_id);
create policy "Users update their own devices" on public.push_subscriptions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users remove their own devices" on public.push_subscriptions for delete to authenticated using (auth.uid() = user_id);

-- 2. What has already been sent, so nothing is sent twice. Only the alerts function reads it.
create table if not exists public.alert_log (
  id       bigserial primary key,
  user_id  uuid not null references auth.users (id) on delete cascade,
  kind     text not null,          -- go | off | digest
  key      text not null,          -- the session (or digest week) it was about
  score    int,
  sent_at  timestamptz not null default now(),
  unique (user_id, kind, key)
);
alter table public.alert_log enable row level security;  -- no policies: only the server can read or write it

-- 3. Run the alerts function every hour, at 5 past.
--    Before running this part: enable the pg_cron and pg_net extensions (Database → Extensions),
--    deploy the check-alerts function, then replace the two placeholders below:
--      PASTE_YOUR_PUBLISHABLE_KEY → Project Settings → API Keys → Publishable key (starts sb_publishable_).
--                                   Supabase needs a project key on every function request.
--      PASTE_YOUR_CRON_SECRET     → the CRON_SECRET from tools/vapid-keys.html.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('tidelight-alerts-hourly')
where exists (select 1 from cron.job where jobname = 'tidelight-alerts-hourly');

select cron.schedule(
  'tidelight-alerts-hourly',
  '5 * * * *',
  $$
  select net.http_post(
    url     := 'https://lwwhoinoredwathgmdij.supabase.co/functions/v1/check-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'PASTE_YOUR_PUBLISHABLE_KEY',
      'x-cron-secret', 'PASTE_YOUR_CRON_SECRET'
    ),
    body    := '{}'::jsonb
  );
  $$
);

-- 4. Optional check: run this a few minutes after 5 past the hour to see the last runs and their results.
-- select status_code, content::text, created from net._http_response order by created desc limit 5;
