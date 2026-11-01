-- MET-72: desktop prepares; the service shares reported local analysis only.
-- Archived hosted tables/functions remain intact. No new jobs or background work.
alter table public.team_repositories alter column installation_id drop not null;
alter table public.team_review_artifacts
 add column origin text check(origin = 'local'),
 add column prepared_by uuid references auth.users;
alter table public.team_review_artifacts add constraint team_local_review_attribution
 check((origin is null and prepared_by is null) or (origin is not null and prepared_by is not null));
-- Only a server fresh source read can populate these extra local-publish fences.
alter table public.team_pr_heads
 add column base_sha text check(base_sha ~ '^[0-9a-f]{40}$'),
 add column context_digest text check(context_digest ~ '^[0-9a-f]{64}$');

create table team_private.local_review_requests (
 user_id uuid not null references auth.users,
 request_id uuid not null,
 key jsonb not null references public.team_review_artifacts(key),
 input_digest text not null check(input_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default now(),
 primary key(user_id,request_id)
);
alter table team_private.local_review_requests enable row level security;
revoke all on team_private.local_review_requests from public,anon,authenticated;
grant all on team_private.local_review_requests to service_role;

create function public.team_publish_local_review(
 p_actor uuid,p_key jsonb,p_review jsonb,p_digest text,p_request uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
 declare prior team_private.local_review_requests; result public.team_review_artifacts;
 begin
 if p_actor is null or p_request is null or not coalesce(team_private.key_valid(p_key),false)
   or p_review is null or jsonb_typeof(p_review) is distinct from 'object'
   or octet_length(p_review::text)>4000000
   or p_digest is distinct from team_private.sha(jsonb_build_object('key',p_key,'review',p_review))
   or p_review->'pr'->>'baseSha' is distinct from p_key->>'baseSha'
   or p_review->'pr'->>'headSha' is distinct from p_key->>'headSha'
   or p_review->'pr'->>'number' is distinct from p_key->>'prNumber'
   then raise exception 'invalid local review';end if;
 if not team_private.can_read((p_key->>'orgId')::uuid,p_key->>'repositoryId',p_actor)
   then raise exception 'forbidden' using errcode='42501';end if;
 if not exists(select 1 from public.team_repository_grants g
   where g.org_id=(p_key->>'orgId')::uuid and g.repository_id=p_key->>'repositoryId' and g.user_id=p_actor
   and g.checked_at>now()-interval '60 seconds' and g.checked_at<=now() and g.expires_at>now())
   then raise exception 'fresh source grant required' using errcode='42501';end if;
 -- Recheck on every attempt, including idempotent retries. Browser/body fields are not authority.
 if not exists(select 1 from public.team_pr_heads h
   where h.org_id=(p_key->>'orgId')::uuid and h.repository_id=p_key->>'repositoryId'
   and h.pr_number=(p_key->>'prNumber')::integer and h.head_sha=p_key->>'headSha'
   and h.base_sha=p_key->>'baseSha' and h.context_digest=p_key->>'contextDigest'
   and h.checked_at>now()-interval '60 seconds' and h.checked_at<=now())
   then raise exception 'stale source context' using errcode='40001';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_actor::text||p_request::text,10));
 select * into prior from team_private.local_review_requests where user_id=p_actor and request_id=p_request;
 if found then
   if prior.key is distinct from p_key or prior.input_digest is distinct from p_digest
     then raise exception 'request conflict' using errcode='40001';end if;
   select * into result from public.team_review_artifacts where key=prior.key;
   return to_jsonb(result);
 end if;
 -- First writer owns the canonical artifact; later valid inferences receive that exact artifact.
 insert into public.team_review_artifacts(key,org_id,repository_id,review,digest,origin,prepared_by)
 values(p_key,(p_key->>'orgId')::uuid,p_key->>'repositoryId',p_review,p_digest,'local',p_actor)
 on conflict(key) do nothing;
 select * into result from public.team_review_artifacts where key=p_key;
 insert into team_private.local_review_requests(user_id,request_id,key,input_digest)
 values(p_actor,p_request,p_key,p_digest);
 return to_jsonb(result);
 end $$;
revoke execute on function public.team_publish_local_review(uuid,jsonb,jsonb,text,uuid) from public,anon,authenticated;
grant execute on function public.team_publish_local_review(uuid,jsonb,jsonb,text,uuid) to service_role;
