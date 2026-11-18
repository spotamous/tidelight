-- Error reports from testers' phones (js/report.js). Already applied to the Tidelight project.
-- Read them in the Supabase dashboard: Table editor, app_errors (newest first), or SQL:
--   select created_at, app_version, kind, message, source, screen, device from app_errors order by created_at desc limit 50;
create table if not exists public.app_errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  app_version text check (char_length(app_version) <= 20),
  screen text check (char_length(screen) <= 60),
  kind text check (kind in ('error', 'rejection', 'startup', 'caught')),
  message text not null check (char_length(message) <= 500),
  source text check (char_length(source) <= 200),
  stack text check (char_length(stack) <= 2000),
  device text check (char_length(device) <= 240)
);
alter table public.app_errors enable row level security;

-- Anyone using the app (signed in or not) can add a report; nobody can read them back through the API.
drop policy if exists "report errors" on public.app_errors;
create policy "report errors" on public.app_errors for insert to anon, authenticated
  with check (user_id is null or user_id = (select auth.uid()));
grant insert on public.app_errors to anon, authenticated;
revoke select, update, delete on public.app_errors from anon, authenticated;

create index if not exists app_errors_created_at on public.app_errors (created_at desc);
