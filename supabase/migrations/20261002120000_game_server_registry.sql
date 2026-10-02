-- Pixelgame: a registry of game servers, so players can find each other's
-- servers from the game's website. Players who host a server themselves
-- (`npm run share`) register it through the game-servers Edge Function,
-- which first checks that the address really answers like a Pixelgame
-- server. Each hosted server gets a short, stable join code. The official
-- server is a row with official = true, added by the project owner.

create table public.game_servers (
  code text primary key check (char_length(code) between 4 and 12),
  name text not null check (char_length(name) between 1 and 40),
  url text not null check (url ~ '^https://[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]{2,5})?$'),
  listed boolean not null default false,
  official boolean not null default false,
  secret_hash text not null,
  players integer not null default 0,
  max_players integer not null default 0,
  protocol integer not null default 0,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

comment on table public.game_servers is 'Pixelgame servers: the official one and those players host. Written only by the game-servers Edge Function.';

-- Nobody reads or writes the table directly (it holds the hosts' secret
-- hashes); everything goes through the functions below.
alter table public.game_servers enable row level security;

create index game_servers_listed on public.game_servers (last_seen) where listed or official;

-- The server list in the lobby: the official server(s) and public servers
-- seen in the last three minutes.
create function public.list_game_servers()
returns table (code text, name text, url text, official boolean, players integer, max_players integer, protocol integer, online boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.code, s.name, s.url, s.official, s.players, s.max_players, s.protocol,
         s.official or s.last_seen > now() - interval '3 minutes'
  from public.game_servers s
  where s.official or (s.listed and s.last_seen > now() - interval '3 minutes')
  order by s.official desc, s.players desc, s.last_seen desc
  limit 50;
$$;

-- A server by its join code (also unlisted ones). `online` says whether the
-- host is running it right now.
create function public.find_game_server(p_code text)
returns table (code text, name text, url text, official boolean, players integer, max_players integer, protocol integer, online boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select s.code, s.name, s.url, s.official, s.players, s.max_players, s.protocol,
         s.official or s.last_seen > now() - interval '3 minutes'
  from public.game_servers s
  where s.code = upper(trim(p_code));
$$;

-- Register or refresh a hosted server (called by the Edge Function with the
-- secret key only). The host proves it owns a code with its secret.
create function public.upsert_game_server(
  p_code text, p_secret_hash text, p_url text, p_name text, p_listed boolean,
  p_players integer, p_max_players integer, p_protocol integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.game_servers;
begin
  select * into existing from public.game_servers where code = p_code for update;
  if found then
    if existing.official or existing.secret_hash <> p_secret_hash then
      raise exception 'not-yours' using errcode = '42501';
    end if;
    update public.game_servers
      set url = p_url, name = p_name, listed = p_listed, players = p_players,
          max_players = p_max_players, protocol = p_protocol, last_seen = now()
      where code = p_code;
  else
    insert into public.game_servers (code, name, url, listed, secret_hash, players, max_players, protocol)
      values (p_code, p_name, p_url, p_listed, p_secret_hash, p_players, p_max_players, p_protocol);
  end if;
  -- Servers nobody has run for two months are forgotten.
  delete from public.game_servers where not official and last_seen < now() - interval '60 days';
  return p_code;
end;
$$;

-- The host stopped its server: hide it from the list right away.
create function public.game_server_offline(p_code text, p_secret_hash text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.game_servers
    set last_seen = now() - interval '1 day', players = 0
    where code = p_code and not official and secret_hash = p_secret_hash;
$$;

revoke all on function public.list_game_servers() from public;
revoke all on function public.find_game_server(text) from public;
revoke all on function public.upsert_game_server(text, text, text, text, boolean, integer, integer, integer) from public;
revoke all on function public.game_server_offline(text, text) from public;

grant execute on function public.list_game_servers() to anon, authenticated;
grant execute on function public.find_game_server(text) to anon, authenticated;
grant execute on function public.upsert_game_server(text, text, text, text, boolean, integer, integer, integer) to service_role;
grant execute on function public.game_server_offline(text, text) to service_role;
