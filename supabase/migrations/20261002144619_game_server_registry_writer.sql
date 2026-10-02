-- The game-servers Edge Function writes the server list with the project's
-- secret key (service_role). Nobody else may read or write the table: the
-- lobby reads through list_game_servers() and find_game_server().
grant select, insert, update, delete on public.game_servers to service_role;
