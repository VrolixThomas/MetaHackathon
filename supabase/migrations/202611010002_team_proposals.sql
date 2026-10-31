-- Exact bounded bundles stay in private RLS tables; no public object URLs.
create function team_private.canonical(v jsonb) returns text language sql immutable strict set search_path='' as $$
 select case jsonb_typeof(v)
 when 'object' then '{'||coalesce((select string_agg(to_jsonb(key)::text||':'||team_private.canonical(value),',' order by key collate "C") from jsonb_each(v)),'')||'}'
 when 'array' then '['||coalesce((select string_agg(team_private.canonical(value),',' order by ord) from jsonb_array_elements(v) with ordinality as a(value,ord)),'')||']'
 else v::text end
$$;
create function team_private.sha(v jsonb) returns text language sql immutable strict set search_path='' as $$select encode(extensions.digest(team_private.canonical(v),'sha256'),'hex')$$;
create table public.team_pr_heads (
 org_id uuid not null,repository_id text not null,pr_number integer not null check(pr_number>0),head_sha text not null check(head_sha ~ '^[0-9a-f]{40}$'),
 github_author_id text not null,checked_at timestamptz not null,primary key(org_id,repository_id,pr_number),foreign key(org_id,repository_id) references public.team_repositories
);
create table public.team_feedback_revisions (
 org_id uuid not null,repository_id text not null,pr_number integer not null,kind text not null check(kind in ('pull-review-comment','issue-comment')),source_id text not null,
 revision text not null,body_digest text not null check(body_digest ~ '^[0-9a-f]{64}$'),checked_at timestamptz not null,
 primary key(org_id,repository_id,kind,source_id),foreign key(org_id,repository_id) references public.team_repositories
);
alter table public.team_feedback_revisions enable row level security;
revoke all on public.team_feedback_revisions from anon,authenticated;
grant all on public.team_feedback_revisions to service_role;
create table public.team_fix_proposals (
 id uuid primary key default gen_random_uuid(),org_id uuid not null,repository_id text not null,key jsonb not null check(team_private.key_valid(key)),
 owner_id uuid not null references auth.users,request_id uuid not null,bundle jsonb not null check(octet_length(bundle::text)<=2200000),bundle_digest text not null check(bundle_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),unique(owner_id,request_id),unique(org_id,repository_id,bundle_digest),foreign key(org_id,repository_id) references public.team_repositories,
 check(org_id=(key->>'orgId')::uuid and repository_id=key->>'repositoryId' and bundle->'key'=key),
 check(bundle_digest=team_private.sha(bundle)),check(bundle->>'baseSha'=key->>'headSha'),
 check(bundle->>'sourcesDigest'=team_private.sha(bundle->'files') and bundle->>'checksDigest'=team_private.sha(bundle->'checks')),
 check(bundle->'patch'->>'sha256'=encode(extensions.digest(bundle->'patch'->>'text','sha256'),'hex')),
 check(bundle->'feedback'->>'bodyDigest'=encode(extensions.digest(bundle->'feedback'->>'body','sha256'),'hex'))
);
create table public.team_proposal_decisions (
 id uuid primary key default gen_random_uuid(),proposal_id uuid not null references public.team_fix_proposals,org_id uuid not null,repository_id text not null,
 author_id uuid not null references auth.users,github_author_id text not null,bundle_digest text not null,decision text not null check(decision in ('accept','decline')),
 request_id uuid not null,created_at timestamptz not null default now(),unique(author_id,request_id),unique(proposal_id)
);
create trigger team_proposal_immutable before update or delete on public.team_fix_proposals for each row execute function team_private.immutable();
create trigger team_decision_immutable before update or delete on public.team_proposal_decisions for each row execute function team_private.immutable();
create table team_private.proposal_share_requests(user_id uuid not null,request_id uuid not null,bundle_digest text not null,proposal_id uuid not null references public.team_fix_proposals,primary key(user_id,request_id));
create function public.team_find_shared_proposal(p_request uuid,p_digest text) returns jsonb language plpgsql security definer set search_path='' as $$
 declare r team_private.proposal_share_requests;p public.team_fix_proposals;
 begin
 select * into r from team_private.proposal_share_requests where user_id=auth.uid() and request_id=p_request;
 if not found then return null;end if;
 if r.bundle_digest<>p_digest then raise exception 'request conflict' using errcode='40001';end if;
 select * into p from public.team_fix_proposals where id=r.proposal_id;
 if not team_private.can_read(p.org_id,p.repository_id) then raise exception 'forbidden' using errcode='42501';end if;
 return to_jsonb(p);
 end $$;
revoke execute on function public.team_find_shared_proposal(uuid,text) from public,anon,authenticated;
grant execute on function public.team_find_shared_proposal(uuid,text) to authenticated;
create function public.team_share_proposal(p_bundle jsonb,p_digest text,p_request uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare u uuid:=auth.uid();k jsonb:=p_bundle->'key';existing public.team_fix_proposals;result public.team_fix_proposals;prior jsonb;f jsonb;c jsonb;
 begin
 if not team_private.can_read((k->>'orgId')::uuid,k->>'repositoryId',u) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_digest is distinct from team_private.sha(p_bundle) then raise exception 'bundle digest mismatch';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_request::text,2));
 prior:=public.team_find_shared_proposal(p_request,p_digest);if prior is not null then return prior;end if;
 if p_bundle->>'provenance'<>'reported-local-candidate' or jsonb_array_length(p_bundle->'files') not between 1 and 40 or jsonb_array_length(p_bundle->'checks')>30 or p_bundle->>'candidateSha' !~ '^[0-9a-f]{40}$' or p_bundle->>'candidateSha'=p_bundle->>'baseSha' then raise exception 'invalid bundle'; end if;
 for f in select value from jsonb_array_elements(p_bundle->'files') loop
 if (f->'before'='null'::jsonb and f->'after'='null'::jsonb) or (f->'before'<>'null'::jsonb and f->'before'->>'sha256' is distinct from encode(extensions.digest(f->'before'->>'text','sha256'),'hex')) or (f->'after'<>'null'::jsonb and f->'after'->>'sha256' is distinct from encode(extensions.digest(f->'after'->>'text','sha256'),'hex')) then raise exception 'source digest mismatch'; end if;
 end loop;
 for c in select value from jsonb_array_elements(p_bundle->'checks') loop
 if c->>'commitSha' is distinct from p_bundle->>'candidateSha' or c->'output'->>'sha256' is distinct from encode(extensions.digest(c->'output'->>'text','sha256'),'hex') then raise exception 'check identity mismatch';end if;
 end loop;
 if not exists(select 1 from public.team_pr_heads where org_id=(k->>'orgId')::uuid and repository_id=k->>'repositoryId' and pr_number=(k->>'prNumber')::integer and head_sha=k->>'headSha' and checked_at>now()-interval '60 seconds') then raise exception 'stale PR head' using errcode='40001'; end if;
 if not exists(select 1 from public.team_feedback_revisions where org_id=(k->>'orgId')::uuid and repository_id=k->>'repositoryId' and pr_number=(k->>'prNumber')::integer and kind=p_bundle->'feedback'->>'kind' and source_id=p_bundle->'feedback'->>'id' and revision=p_bundle->'feedback'->>'revision' and body_digest=p_bundle->'feedback'->>'bodyDigest' and checked_at>now()-interval '60 seconds') then raise exception 'current source feedback required' using errcode='40001';end if;

 insert into public.team_fix_proposals(org_id,repository_id,key,owner_id,request_id,bundle,bundle_digest) values((k->>'orgId')::uuid,k->>'repositoryId',k,u,p_request,p_bundle,p_digest) on conflict(org_id,repository_id,bundle_digest) do nothing returning * into result;
 if result.id is null then select * into result from public.team_fix_proposals where org_id=(k->>'orgId')::uuid and repository_id=k->>'repositoryId' and bundle_digest=p_digest;end if;
 insert into team_private.proposal_share_requests values(u,p_request,p_digest,result.id);
 return to_jsonb(result);
 end $$;
create function public.team_decide_proposal(p_id uuid,p_digest text,p_decision text,p_request uuid,p_confirmed boolean) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare u uuid:=auth.uid();p public.team_fix_proposals;head public.team_pr_heads;g public.team_repository_grants;d public.team_proposal_decisions;
 begin
 select * into p from public.team_fix_proposals where id=p_id;
 if not found or not team_private.can_read(p.org_id,p.repository_id,u) then raise exception 'forbidden' using errcode='42501';end if;
 if p_confirmed is distinct from true or p.bundle_digest<>p_digest or p_decision not in ('accept','decline') then raise exception 'exact confirmation required';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_request::text,3));
 select * into d from public.team_proposal_decisions where author_id=u and request_id=p_request;
 if found then if d.proposal_id<>p_id or d.bundle_digest<>p_digest or d.decision<>p_decision then raise exception 'request conflict' using errcode='40001';end if;return to_jsonb(d);end if;
 select * into head from public.team_pr_heads where org_id=p.org_id and repository_id=p.repository_id and pr_number=(p.key->>'prNumber')::integer;
 select * into g from public.team_repository_grants where org_id=p.org_id and repository_id=p.repository_id and user_id=u;
 if head.checked_at<=now()-interval '60 seconds' or head.head_sha<>p.key->>'headSha' or head.github_author_id is distinct from g.github_user_id then raise exception 'current PR author required' using errcode='42501';end if;
 if not exists(select 1 from public.team_feedback_revisions where org_id=p.org_id and repository_id=p.repository_id and pr_number=(p.key->>'prNumber')::integer and kind=p.bundle->'feedback'->>'kind' and source_id=p.bundle->'feedback'->>'id' and revision=p.bundle->'feedback'->>'revision' and body_digest=p.bundle->'feedback'->>'bodyDigest' and checked_at>now()-interval '60 seconds') then raise exception 'current source feedback required' using errcode='40001';end if;

 begin
 insert into public.team_proposal_decisions(proposal_id,org_id,repository_id,author_id,github_author_id,bundle_digest,decision,request_id) values(p_id,p.org_id,p.repository_id,u,head.github_author_id,p_digest,p_decision,p_request) returning * into d;
 exception when unique_violation then raise exception 'already decided' using errcode='40001'; end;
 return to_jsonb(d);
 end $$;
alter table public.team_pr_heads enable row level security;
alter table public.team_fix_proposals enable row level security;
alter table public.team_proposal_decisions enable row level security;
create policy proposal_reader on public.team_fix_proposals for select to authenticated using(team_private.can_read(org_id,repository_id));
create policy decision_reader on public.team_proposal_decisions for select to authenticated using(team_private.can_read(org_id,repository_id));
revoke all on public.team_pr_heads,public.team_fix_proposals,public.team_proposal_decisions from anon,authenticated;
grant select on public.team_fix_proposals,public.team_proposal_decisions to authenticated;
grant all on public.team_pr_heads,public.team_fix_proposals,public.team_proposal_decisions to service_role;
revoke execute on function public.team_share_proposal(jsonb,text,uuid),public.team_decide_proposal(uuid,text,text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.team_share_proposal(jsonb,text,uuid),public.team_decide_proposal(uuid,text,text,uuid,boolean) to authenticated;
-- Authenticated requests use the same immutable context/version dedup as webhook preparation.
create function public.team_request_preparation(p_key jsonb,p_context jsonb) returns void
 language plpgsql security definer set search_path='' as $$
 begin
 if not exists(select 1 from public.team_repositories where org_id=(p_key->>'orgId')::uuid and repository_id=p_key->>'repositoryId' and enabled) then raise exception 'repository unauthorized' using errcode='42501';end if;
 if p_key->>'contextDigest' is distinct from team_private.sha(p_context) or p_context->'pr'->>'baseSha' is distinct from p_key->>'baseSha' or p_context->'pr'->>'headSha' is distinct from p_key->>'headSha' or p_context->'pr'->>'number' is distinct from p_key->>'prNumber' then raise exception 'context mismatch';end if;
 insert into public.team_preparation_jobs(key,org_id,repository_id,context) values(p_key,(p_key->>'orgId')::uuid,p_key->>'repositoryId',p_context) on conflict(key) do nothing;
 end $$;
revoke execute on function public.team_request_preparation(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.team_request_preparation(jsonb,jsonb) to service_role;
-- Defend the authenticated RPC as well as the HTTP validator.
create function team_private.valid_bundle(p jsonb) returns boolean language plpgsql immutable set search_path='' as $$
 declare f jsonb;c jsonb;b jsonb;k jsonb:=p->'key';
 begin
 if not coalesce(team_private.key_valid(k),false) or jsonb_typeof(p->'files')<>'array' or jsonb_typeof(p->'checks')<>'array' or jsonb_array_length(p->'files') not between 1 and 40 or jsonb_array_length(p->'checks')>30 then return false;end if;
 if (select count(*) from jsonb_object_keys(p))<>10 or p->>'baseSha' is distinct from k->>'headSha' or not coalesce(p->>'candidateSha' ~ '^[0-9a-f]{40}$',false) or p->>'candidateSha'=p->>'baseSha' or p->>'provenance' is distinct from 'reported-local-candidate' then return false;end if;
 if p->>'sourcesDigest' is distinct from team_private.sha(p->'files') or p->>'checksDigest' is distinct from team_private.sha(p->'checks') or p->'feedback'->>'kind' not in ('pull-review-comment','issue-comment') or not coalesce(p->'feedback'->>'id' ~ '^[1-9][0-9]{0,18}$',false) or length(p->'feedback'->>'body') not between 1 and 16000 or p->'feedback'->>'bodyDigest' is distinct from encode(extensions.digest(p->'feedback'->>'body','sha256'),'hex') or p->'feedback'->>'revision' is null then return false;end if;
 if length(p->'patch'->>'text') not between 1 and 300000 or p->'patch'->>'sha256' is distinct from encode(extensions.digest(p->'patch'->>'text','sha256'),'hex') then return false;end if;
 if (select count(distinct value->>'path') from jsonb_array_elements(p->'files'))<>jsonb_array_length(p->'files') then return false;end if;
 for f in select value from jsonb_array_elements(p->'files') loop
 if not coalesce(length(f->>'path') between 1 and 4096,false) or f->>'path' ~ '(^/|\\|(^|/)\.\.?(/|$))' or not(f?'before' and f?'after') or (f->'before'='null'::jsonb and f->'after'='null'::jsonb) or f->'before'=f->'after' then return false;end if;
 for b in select value from jsonb_array_elements(jsonb_build_array(f->'before',f->'after')) loop
 if b<>'null'::jsonb and (jsonb_typeof(b->'text') is distinct from 'string' or length(b->>'text')>300000 or b->>'sha256' is distinct from encode(extensions.digest(b->>'text','sha256'),'hex')) then return false;end if;
 end loop;
 end loop;
 for c in select value from jsonb_array_elements(p->'checks') loop
 if c->>'commitSha' is distinct from p->>'candidateSha' or jsonb_typeof(c->'command') is distinct from 'array' or jsonb_array_length(c->'command') not between 1 and 30 or c->>'exitCode' !~ '^-?[0-9]+$' or c->>'environment' is null or (c->>'finishedAt')::timestamptz<(c->>'startedAt')::timestamptz or c->'output'->>'sha256' is distinct from encode(extensions.digest(c->'output'->>'text','sha256'),'hex') then return false;end if;
 end loop;
 return true;
 exception when others then return false;
 end $$;
alter table public.team_fix_proposals add constraint team_exact_bundle check(coalesce(team_private.valid_bundle(bundle),false));
create policy preparation_status_reader on public.team_preparation_jobs for select to authenticated using(team_private.can_read(org_id,repository_id));
grant select(key,state,error_code,attempts) on public.team_preparation_jobs to authenticated;
create table team_private.preparation_retries(user_id uuid not null,request_id uuid not null,key jsonb not null,created_at timestamptz not null default now(),primary key(user_id,request_id));
create function public.team_retry_preparation(p_key jsonb,p_request uuid) returns void
 language plpgsql security definer set search_path='' as $$
 declare u uuid:=auth.uid();prior jsonb;
 begin
 if not team_private.can_read((p_key->>'orgId')::uuid,p_key->>'repositoryId',u) then raise exception 'forbidden' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_request::text,4));
 select key into prior from team_private.preparation_retries where user_id=u and request_id=p_request;
 if found then if prior<>p_key then raise exception 'request conflict' using errcode='40001';end if;return;end if;
 if not exists(select 1 from public.team_preparation_jobs where key=p_key) then raise exception 'missing preparation';end if;
 insert into team_private.preparation_retries(user_id,request_id,key) values(u,p_request,p_key);
 update public.team_preparation_jobs set state='queued',attempts=0,error_code=null,available_at=now(),lease_token=null,lease_until=null where key=p_key and state='failed';
 end $$;
revoke execute on function public.team_retry_preparation(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.team_retry_preparation(jsonb,uuid) to authenticated;
