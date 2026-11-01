-- Supabase-only queue wakeups. Install the administrative controls without enabling jobs.
-- Plain PostgreSQL policy tests have no managed extensions; hosted Supabase provides them.
do $$
begin
  if exists(select 1 from pg_available_extensions where name='pg_cron') then
    create extension if not exists pg_cron;
  end if;
  if exists(select 1 from pg_available_extensions where name='pg_net') then
    create extension if not exists pg_net with schema extensions;
  end if;
  if exists(select 1 from pg_available_extensions where name='supabase_vault') then
    create extension if not exists supabase_vault;
  end if;
end
$$;

create function public.team_worker_scheduler_status() returns jsonb
language plpgsql security definer set search_path='' as $$
declare jobs jsonb; configured boolean;
begin
  if to_regclass('cron.job') is null or to_regclass('vault.secrets') is null
     or not exists(select 1 from pg_extension where extname='pg_net') then
    return jsonb_build_object('available',false,'configured',false,'jobs','[]'::jsonb);
  end if;
  select count(*)=2 into configured from vault.secrets
    where name in ('muse_worker_project_url','muse_worker_invoke_secret');
  select coalesce(jsonb_agg(jsonb_build_object('name',jobname,'active',active,'schedule',schedule)
    order by jobname),'[]'::jsonb) into jobs from cron.job
    where jobname in ('muse-team-webhook-queue','muse-team-preparation-queue');
  return jsonb_build_object('available',true,'configured',configured,'jobs',jobs);
end
$$;

create function public.team_configure_worker_scheduler(
  p_project_url text default null, p_invoker_secret text default null, p_enabled boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $$
declare item record; secret_id uuid; job record;
begin
  if p_enabled is null then raise exception 'explicit scheduler state required'; end if;
  if to_regclass('cron.job') is null or to_regclass('vault.secrets') is null
     or not exists(select 1 from pg_extension where extname='pg_net') then
    raise exception 'managed scheduler extensions unavailable' using errcode='55000';
  end if;
  if p_enabled and (p_project_url is null or p_project_url !~ '^https://[a-z0-9]{20}\.supabase\.co$'
     or p_invoker_secret is null or p_invoker_secret !~ '^[A-Za-z0-9_-]{32,128}$') then
    raise exception 'valid project URL and dedicated invocation secret required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('muse-worker-scheduler',0));
  for job in select jobid from cron.job
    where jobname in ('muse-team-webhook-queue','muse-team-preparation-queue') loop
    perform cron.unschedule(job.jobid);
  end loop;
  if not p_enabled then return public.team_worker_scheduler_status(); end if;

  -- A leaked invocation key can only wake an already authorized queue, not administer the DB.
  -- Never use the service-role key in pg_net headers: queued HTTP headers are temporarily stored.
  for item in select key,value from jsonb_each_text(jsonb_build_object(
    'muse_worker_project_url',p_project_url,'muse_worker_invoke_secret',p_invoker_secret)) loop
    select id into secret_id from vault.secrets where name=item.key;
    if found then
      perform vault.update_secret(secret_id,item.value,item.key,'Muse finite queue worker');
    else
      perform vault.create_secret(item.value,item.key,'Muse finite queue worker');
    end if;
  end loop;

  perform cron.schedule('muse-team-webhook-queue','* * * * *',$job$
    select net.http_post(
      url:=(select decrypted_secret from vault.decrypted_secrets where name='muse_worker_project_url')
        ||'/functions/v1/muse-team-worker',
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '
        ||(select decrypted_secret from vault.decrypted_secrets where name='muse_worker_invoke_secret')),
      body:='{"queue":"webhook"}'::jsonb, timeout_milliseconds:=10000);
  $job$);
  perform cron.schedule('muse-team-preparation-queue','* * * * *',$job$
    select net.http_post(
      url:=(select decrypted_secret from vault.decrypted_secrets where name='muse_worker_project_url')
        ||'/functions/v1/muse-team-worker',
      headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '
        ||(select decrypted_secret from vault.decrypted_secrets where name='muse_worker_invoke_secret')),
      body:='{"queue":"preparation"}'::jsonb, timeout_milliseconds:=10000);
  $job$);
  return public.team_worker_scheduler_status();
end
$$;

revoke execute on function public.team_worker_scheduler_status(),
  public.team_configure_worker_scheduler(text,text,boolean) from public,anon,authenticated;
grant execute on function public.team_worker_scheduler_status(),
  public.team_configure_worker_scheduler(text,text,boolean) to service_role;

do $$
begin
  if exists(select 1 from pg_namespace where nspname='vault') then
    revoke usage on schema vault from anon,authenticated;
    revoke all on all tables in schema vault from anon,authenticated;
  end if;
  if exists(select 1 from pg_namespace where nspname='cron') then
    revoke usage on schema cron from anon,authenticated;
    revoke all on all tables in schema cron from anon,authenticated;
  end if;
  if exists(select 1 from pg_namespace where nspname='net') then
    revoke usage on schema net from anon,authenticated;
    revoke all on all tables in schema net from anon,authenticated;
  end if;
end
$$;
