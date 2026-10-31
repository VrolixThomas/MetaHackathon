-- MET-72/73/41. Server-managed authorization; no desktop admin key.
create extension if not exists pgcrypto with schema extensions;
create schema if not exists team_private;
revoke all on schema team_private from public;
create table public.team_organizations (id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 160));
create table public.team_memberships (
 org_id uuid not null references public.team_organizations on delete cascade,
 user_id uuid not null references auth.users on delete cascade, active boolean not null default true,
 primary key(org_id,user_id)
);
create table public.team_repositories (
 org_id uuid not null references public.team_organizations on delete cascade,
 repository_id text not null check(repository_id ~ '^[1-9][0-9]{0,18}$'),
 full_name text not null check(full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
 installation_id text not null check(installation_id ~ '^[1-9][0-9]{0,18}$'), enabled boolean not null default true,
 primary key(org_id,repository_id)
);
create table public.team_repository_grants (
 org_id uuid not null, repository_id text not null, user_id uuid not null references auth.users on delete cascade,
 github_user_id text not null, checked_at timestamptz not null default now(), expires_at timestamptz not null,
 primary key(org_id,repository_id,user_id), foreign key(org_id,repository_id) references public.team_repositories on delete cascade,
 check(expires_at > checked_at and expires_at <= checked_at + interval '60 seconds')
);
create function team_private.can_read(o uuid,r text,u uuid default auth.uid()) returns boolean
 language sql stable security definer set search_path='' as $$
 select u is not null and exists(select 1 from public.team_memberships m join public.team_repository_grants g on g.org_id=m.org_id and g.user_id=m.user_id join public.team_repositories r on r.org_id=g.org_id and r.repository_id=g.repository_id
 where m.org_id=o and m.user_id=u and m.active and g.repository_id=$2 and g.expires_at > now() and r.enabled)
$$;
create function team_private.key_valid(k jsonb) returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(k)='object' and (select count(*) from jsonb_object_keys(k))=7
 and k->>'orgId' ~ '^[0-9a-fA-F-]{36}$' and k->>'repositoryId' ~ '^[1-9][0-9]{0,18}$'
 and k->>'prNumber' ~ '^[1-9][0-9]{0,8}$' and k->>'baseSha' ~ '^[0-9a-f]{40}$' and k->>'headSha' ~ '^[0-9a-f]{40}$'
 and k->>'contextDigest' ~ '^[0-9a-f]{64}$' and k->>'analysisVersion' ~ '^[a-zA-Z0-9._:-]{1,160}$',false)
$$;
create table public.team_review_artifacts (
 key jsonb primary key check(team_private.key_valid(key)), org_id uuid not null, repository_id text not null,
 review jsonb not null check(octet_length(review::text)<=4000000), digest text not null check(digest ~ '^[0-9a-f]{64}$'), created_at timestamptz not null default now(),
 foreign key(org_id,repository_id) references public.team_repositories,
 check(org_id=(key->>'orgId')::uuid and repository_id=key->>'repositoryId'),
 check(review->'pr'->>'baseSha'=key->>'baseSha' and review->'pr'->>'headSha'=key->>'headSha' and review->'pr'->>'number'=key->>'prNumber')
);
create table public.team_review_progress (
 user_id uuid not null references auth.users on delete cascade, key jsonb not null references public.team_review_artifacts(key),
 org_id uuid not null, repository_id text not null, progress jsonb not null check(octet_length(progress::text)<=100000),
 revision integer not null check(revision>0), request_id uuid not null, request_digest text not null,
 updated_at timestamptz not null default now(), primary key(user_id,key),
 check(org_id=(key->>'orgId')::uuid and repository_id=key->>'repositoryId')
);
-- Transactional idempotency ledger survives another device's later cursor updates.
create table team_private.progress_requests(user_id uuid not null, request_id uuid not null, input jsonb not null, result jsonb not null, primary key(user_id,request_id));
create function public.team_write_progress(p_key jsonb,p_progress jsonb,p_expected integer,p_request uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare u uuid:=auth.uid(); previous team_private.progress_requests; current_revision integer; result jsonb; input jsonb:=jsonb_build_object('key',p_key,'progress',p_progress,'expected',p_expected);
 begin
 if not team_private.can_read((p_key->>'orgId')::uuid,p_key->>'repositoryId',u) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_progress->'key' is distinct from p_key or (p_progress->>'revision')::integer <> p_expected or p_expected<0 then raise exception 'invalid progress'; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text || p_request::text,0));
 select * into previous from team_private.progress_requests where user_id=u and request_id=p_request;
 if found then if previous.input is distinct from input then raise exception 'request conflict' using errcode='40001'; end if; return previous.result; end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text || p_key::text,1));
 select revision into current_revision from public.team_review_progress where user_id=u and key=p_key;
 if coalesce(current_revision,0)<>p_expected then raise exception 'revision conflict' using errcode='40001'; end if;
 result:=p_progress || jsonb_build_object('revision',p_expected+1);
 insert into public.team_review_progress(user_id,key,org_id,repository_id,progress,revision,request_id,request_digest)
 values(u,p_key,(p_key->>'orgId')::uuid,p_key->>'repositoryId',result,p_expected+1,p_request,encode(extensions.digest(input::text,'sha256'),'hex'))
 on conflict(user_id,key) do update set progress=excluded.progress,revision=excluded.revision,request_id=excluded.request_id,request_digest=excluded.request_digest,updated_at=now();
 insert into team_private.progress_requests values(u,p_request,input,result); return result;
 end $$;
-- Queue contains approved pinned repository context only. No personal notes or private provider context.
create table public.team_preparation_jobs (
 id uuid primary key default gen_random_uuid(), key jsonb unique not null check(team_private.key_valid(key)),
 org_id uuid not null, repository_id text not null, context jsonb not null check(octet_length(context::text)<=2000000),
 state text not null default 'queued' check(state in ('queued','leased','ready','failed')), attempts integer not null default 0,
 lease_token uuid, lease_until timestamptz, available_at timestamptz not null default now(), error_code text, created_at timestamptz not null default now(),
 foreign key(org_id,repository_id) references public.team_repositories,
 check(org_id=(key->>'orgId')::uuid and repository_id=key->>'repositoryId')
);
create table public.team_webhooks (
 delivery_id uuid primary key, body_digest text not null check(body_digest ~ '^[0-9a-f]{64}$'),
 org_id uuid not null, repository_id text not null, installation_id text not null,
 payload jsonb not null check(octet_length(payload::text)<=1000000), state text not null default 'queued' check(state in ('queued','leased','ready','failed')),
 attempts integer not null default 0, lease_token uuid, lease_until timestamptz, available_at timestamptz not null default now(), error_code text,
 foreign key(org_id,repository_id) references public.team_repositories
);
create function public.team_ingest_webhook(p_delivery uuid,p_digest text,p_org uuid,p_repository text,p_installation text,p_payload jsonb) returns void
 language plpgsql security definer set search_path='' as $$
 declare old_digest text;
 begin
 if not exists(select 1 from public.team_repositories where org_id=p_org and repository_id=p_repository and installation_id=p_installation and enabled) then raise exception 'repository unauthorized' using errcode='42501'; end if;
 insert into public.team_webhooks(delivery_id,body_digest,org_id,repository_id,installation_id,payload) values(p_delivery,p_digest,p_org,p_repository,p_installation,p_payload) on conflict do nothing;
 select body_digest into old_digest from public.team_webhooks where delivery_id=p_delivery;
 if old_digest<>p_digest then raise exception 'delivery conflict' using errcode='40001'; end if;
 end $$;
create function public.team_enqueue_preparation(p_key jsonb,p_context jsonb,p_webhook uuid,p_token uuid) returns void
 language plpgsql security definer set search_path='' as $$
 declare w public.team_webhooks;
 begin
 select * into w from public.team_webhooks where delivery_id=p_webhook for update;
 if not found or w.state<>'leased' or w.lease_token<>p_token or w.lease_until<=now() then raise exception 'stale lease' using errcode='40001'; end if;
 if w.org_id<>(p_key->>'orgId')::uuid or w.repository_id<>p_key->>'repositoryId' or not exists(select 1 from public.team_repositories where org_id=w.org_id and repository_id=w.repository_id and installation_id=w.installation_id and enabled) then raise exception 'repository unauthorized' using errcode='42501'; end if;
 if p_context->'pr'->>'baseSha'<>p_key->>'baseSha' or p_context->'pr'->>'headSha'<>p_key->>'headSha' then raise exception 'context mismatch'; end if;
 insert into public.team_preparation_jobs(key,org_id,repository_id,context) values(p_key,w.org_id,w.repository_id,p_context) on conflict(key) do nothing;
 update public.team_webhooks set state='ready',lease_token=null,lease_until=null where delivery_id=p_webhook;
 end $$;
create function public.team_claim(p_queue text,p_lease_seconds integer default 120) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare result jsonb;
 begin
 if p_lease_seconds not between 10 and 600 then raise exception 'invalid lease'; end if;
 if p_queue='webhook' then
 with candidate as (select delivery_id from public.team_webhooks where attempts<5 and available_at<=now() and (state='queued' or (state='leased' and lease_until<=now())) order by available_at for update skip locked limit 1)
 update public.team_webhooks j set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds) from candidate c where j.delivery_id=c.delivery_id returning to_jsonb(j) into result;
 elsif p_queue='preparation' then
 with candidate as (select id from public.team_preparation_jobs where attempts<5 and available_at<=now() and (state='queued' or (state='leased' and lease_until<=now())) order by available_at for update skip locked limit 1)
 update public.team_preparation_jobs j set state='leased',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+make_interval(secs=>p_lease_seconds) from candidate c where j.id=c.id returning to_jsonb(j) into result;
 else raise exception 'invalid queue'; end if;
 return result;
 end $$;
create function public.team_renew(p_queue text,p_id uuid,p_token uuid,p_seconds integer default 120) returns boolean
 language plpgsql security definer set search_path='' as $$
 declare changed integer;
 begin
 if p_seconds not between 10 and 600 then raise exception 'invalid lease'; end if;
 if p_queue='webhook' then update public.team_webhooks set lease_until=now()+make_interval(secs=>p_seconds) where delivery_id=p_id and state='leased' and lease_token=p_token and lease_until>now();
 elsif p_queue='preparation' then update public.team_preparation_jobs set lease_until=now()+make_interval(secs=>p_seconds) where id=p_id and state='leased' and lease_token=p_token and lease_until>now();
 else raise exception 'invalid queue'; end if;
 get diagnostics changed=row_count; return changed=1;
 end $$;
create function public.team_finish_preparation(p_id uuid,p_token uuid,p_review jsonb,p_digest text) returns void
 language plpgsql security definer set search_path='' as $$
 declare job public.team_preparation_jobs;
 begin
 select * into job from public.team_preparation_jobs where id=p_id for update;
 if not found or job.state<>'leased' or job.lease_token<>p_token or job.lease_until<=now() then raise exception 'stale lease' using errcode='40001'; end if;
 if not exists(select 1 from public.team_repositories where org_id=job.org_id and repository_id=job.repository_id and enabled) then raise exception 'repository unauthorized' using errcode='42501'; end if;
 insert into public.team_review_artifacts(key,org_id,repository_id,review,digest) values(job.key,job.org_id,job.repository_id,p_review,p_digest) on conflict(key) do nothing;
 update public.team_preparation_jobs set state='ready',lease_token=null,lease_until=null,error_code=null where id=p_id;
 end $$;
create function public.team_fail(p_queue text,p_id uuid,p_token uuid,p_error text) returns void
 language plpgsql security definer set search_path='' as $$
 begin
 if p_error not in ('provider','source','revoked','invalid','unavailable') then raise exception 'invalid error'; end if;
 if p_queue='webhook' then update public.team_webhooks set state=case when attempts>=5 or p_error in ('revoked','invalid') then 'failed' else 'queued' end,available_at=now()+make_interval(secs=>least(300,attempts*30)),error_code=p_error,lease_token=null,lease_until=null where delivery_id=p_id and state='leased' and lease_token=p_token and lease_until>now();
 elsif p_queue='preparation' then update public.team_preparation_jobs set state=case when attempts>=5 or p_error in ('revoked','invalid') then 'failed' else 'queued' end,available_at=now()+make_interval(secs=>least(300,attempts*30)),error_code=p_error,lease_token=null,lease_until=null where id=p_id and state='leased' and lease_token=p_token and lease_until>now();
 else raise exception 'invalid queue'; end if;
 end $$;
-- No UPDATE/DELETE rights on canonical analyses, even for an authenticated author.
create function team_private.immutable() returns trigger language plpgsql set search_path='' as $$ begin raise exception 'immutable artifact'; end $$;
create trigger team_review_immutable before update or delete on public.team_review_artifacts for each row execute function team_private.immutable();
alter table public.team_organizations enable row level security;
alter table public.team_memberships enable row level security;
alter table public.team_repositories enable row level security;
alter table public.team_repository_grants enable row level security;
alter table public.team_review_artifacts enable row level security;
alter table public.team_review_progress enable row level security;
alter table public.team_preparation_jobs enable row level security;
alter table public.team_webhooks enable row level security;
create policy org_member on public.team_organizations for select to authenticated using(exists(select 1 from public.team_memberships m where m.org_id=id and m.user_id=auth.uid() and m.active));
create policy own_membership on public.team_memberships for select to authenticated using(user_id=auth.uid() and active);
create policy repo_reader on public.team_repositories for select to authenticated using(team_private.can_read(org_id,repository_id));
create policy own_grant on public.team_repository_grants for select to authenticated using(user_id=auth.uid() and team_private.can_read(org_id,repository_id));
create policy artifact_reader on public.team_review_artifacts for select to authenticated using(team_private.can_read(org_id,repository_id));
create policy private_progress on public.team_review_progress for select to authenticated using(user_id=auth.uid() and team_private.can_read(org_id,repository_id));
revoke all on public.team_organizations,public.team_memberships,public.team_repositories,public.team_repository_grants,public.team_review_artifacts,public.team_review_progress,public.team_preparation_jobs,public.team_webhooks from anon,authenticated;
grant select on public.team_organizations,public.team_memberships,public.team_repositories,public.team_repository_grants,public.team_review_artifacts,public.team_review_progress to authenticated;
grant all on all tables in schema team_private to service_role;
grant usage on schema team_private to authenticated,service_role;
grant execute on function team_private.can_read(uuid,text,uuid) to authenticated;
revoke execute on function public.team_write_progress(jsonb,jsonb,integer,uuid),public.team_ingest_webhook(uuid,text,uuid,text,text,jsonb),public.team_enqueue_preparation(jsonb,jsonb,uuid,uuid),public.team_claim(text,integer),public.team_renew(text,uuid,uuid,integer),public.team_finish_preparation(uuid,uuid,jsonb,text),public.team_fail(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.team_write_progress(jsonb,jsonb,integer,uuid) to authenticated;
grant execute on function public.team_ingest_webhook(uuid,text,uuid,text,text,jsonb),public.team_enqueue_preparation(jsonb,jsonb,uuid,uuid),public.team_claim(text,integer),public.team_renew(text,uuid,uuid,integer),public.team_finish_preparation(uuid,uuid,jsonb,text),public.team_fail(text,uuid,uuid,text) to service_role;

grant all on public.team_organizations,public.team_memberships,public.team_repositories,public.team_repository_grants,public.team_review_artifacts,public.team_review_progress,public.team_preparation_jobs,public.team_webhooks to service_role;
