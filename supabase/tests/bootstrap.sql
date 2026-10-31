-- Local isolated PostgreSQL only: stand-ins for Supabase's managed auth roles/schema.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create schema extensions;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public,auth,extensions to anon,authenticated,service_role;
grant execute on function auth.uid() to authenticated,service_role;
