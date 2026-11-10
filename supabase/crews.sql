-- Tidelight crews. Already applied to the Tidelight Supabase project (migrations tidelight_crews and
-- tidelight_crews_private_membership_check). Kept here for reference or for setting up a new project.

create table if not exists public.crews (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique,
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create table if not exists public.crew_members (
  crew_id uuid not null references public.crews (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 40),
  joined_at timestamptz not null default now(),
  primary key (crew_id, user_id)
);
create table if not exists public.crew_plans (
  id uuid primary key default gen_random_uuid(),
  crew_id uuid not null references public.crews (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  display_name text not null, session_key text not null, spot_name text not null,
  lat double precision not null, lon double precision not null, type text not null,
  t bigint not null, day_t bigint, leave bigint, offset_s int not null default 0,
  score int, hunt text, note text check (note is null or char_length(note) <= 200),
  created_at timestamptz not null default now(),
  unique (crew_id, user_id, session_key)
);
create index if not exists crew_plans_crew_t on public.crew_plans (crew_id, t);
alter table public.crews enable row level security;
alter table public.crew_members enable row level security;
alter table public.crew_plans enable row level security;

create schema if not exists private;
grant usage on schema private to authenticated;
create or replace function private.is_crew_member(c uuid) returns boolean language sql security definer stable set search_path = public
as $$ select exists (select 1 from public.crew_members where crew_id = c and user_id = auth.uid()) $$;
revoke all on function private.is_crew_member(uuid) from public, anon;
grant execute on function private.is_crew_member(uuid) to authenticated;

create policy "Members see their crews" on public.crews for select to authenticated using (private.is_crew_member(id));
create policy "Members see each other" on public.crew_members for select to authenticated using (private.is_crew_member(crew_id));
create policy "Members rename themselves" on public.crew_members for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Members leave crews" on public.crew_members for delete to authenticated using (user_id = auth.uid());
create policy "Members see crew plans" on public.crew_plans for select to authenticated using (private.is_crew_member(crew_id));
create policy "Members share plans" on public.crew_plans for insert to authenticated with check (user_id = auth.uid() and private.is_crew_member(crew_id));
create policy "Members edit their plans" on public.crew_plans for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "Members remove their plans" on public.crew_plans for delete to authenticated using (user_id = auth.uid());

create or replace function public.create_crew(p_name text, p_display_name text)
returns public.crews language plpgsql security definer set search_path = public
as $$
declare c public.crews; code text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  loop
    code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6));
    exit when not exists (select 1 from public.crews where invite_code = code);
  end loop;
  insert into public.crews (name, invite_code, created_by) values (trim(p_name), code, auth.uid()) returning * into c;
  insert into public.crew_members (crew_id, user_id, display_name) values (c.id, auth.uid(), trim(p_display_name));
  return c;
end $$;

create or replace function public.join_crew(p_code text, p_display_name text)
returns public.crews language plpgsql security definer set search_path = public
as $$
declare c public.crews;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into c from public.crews where invite_code = upper(trim(p_code));
  if not found then raise exception 'No crew uses that code. Check it with whoever sent it.'; end if;
  insert into public.crew_members (crew_id, user_id, display_name) values (c.id, auth.uid(), trim(p_display_name))
  on conflict (crew_id, user_id) do update set display_name = excluded.display_name;
  return c;
end $$;

revoke all on function public.create_crew(text, text) from public, anon;
revoke all on function public.join_crew(text, text) from public, anon;
grant execute on function public.create_crew(text, text) to authenticated;
grant execute on function public.join_crew(text, text) to authenticated;
