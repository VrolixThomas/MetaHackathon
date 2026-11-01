\set ON_ERROR_STOP on
begin;
do $$
begin
  if has_function_privilege('authenticated','public.team_worker_scheduler_status()','execute')
    or has_function_privilege('anon','public.team_worker_scheduler_status()','execute')
    or has_function_privilege('authenticated','public.team_configure_worker_scheduler(text,text,boolean)','execute')
    or has_function_privilege('anon','public.team_configure_worker_scheduler(text,text,boolean)','execute') then
    raise exception 'scheduler administration exposed to app roles';
  end if;
  if not has_function_privilege('service_role','public.team_configure_worker_scheduler(text,text,boolean)','execute') then
    raise exception 'server cannot configure scheduler';
  end if;
end
$$;
set local role authenticated;
do $$
begin
  begin
    perform public.team_configure_worker_scheduler('https://example.supabase.co','controlled',true);
    raise exception 'app role configured queue wakeups';
  exception when insufficient_privilege then null;
  end;
end
$$;
reset role;
set local role service_role;
select public.team_worker_scheduler_status();
reset role;
rollback;
