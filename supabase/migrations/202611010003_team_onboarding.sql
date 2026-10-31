-- Explicit onboarding. Membership alone cannot claim or register repositories.
create table public.team_organization_owners(org_id uuid not null references public.team_organizations,user_id uuid not null references auth.users,primary key(org_id,user_id));
alter table public.team_organization_owners enable row level security;
create policy own_org_owner on public.team_organization_owners for select to authenticated using(user_id=auth.uid() and exists(select 1 from public.team_memberships m where m.org_id=team_organization_owners.org_id and m.user_id=auth.uid() and m.active));
revoke all on public.team_organization_owners from anon,authenticated;
grant select on public.team_organization_owners to authenticated;
grant all on public.team_organization_owners to service_role;
create table team_private.onboarding_requests(user_id uuid not null,request_id uuid not null,kind text not null,input jsonb not null,result jsonb not null,primary key(user_id,request_id));
create function public.team_create_organization(p_user uuid,p_name text,p_request uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare prior team_private.onboarding_requests;o uuid;result jsonb;input jsonb:=jsonb_build_object('name',p_name);
 begin
 if length(trim(p_name)) not between 1 and 160 or p_name is null or p_request is null or not exists(select 1 from auth.users where id=p_user) then raise exception 'invalid onboarding';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||p_request::text,8));
 select * into prior from team_private.onboarding_requests where user_id=p_user and request_id=p_request;
 if found then if prior.kind<>'organization' or prior.input<>input then raise exception 'request conflict' using errcode='40001';end if;return prior.result;end if;
 insert into public.team_organizations(name)values(p_name)returning id into o;
 insert into public.team_memberships values(o,p_user,true);
 insert into public.team_organization_owners values(o,p_user);
 result:=jsonb_build_object('id',o,'name',p_name);
 insert into team_private.onboarding_requests values(p_user,p_request,'organization',input,result);return result;
 end $$;
create function public.team_register_repository(p_user uuid,p_org uuid,p_repository text,p_name text,p_installation text,p_request uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare prior team_private.onboarding_requests;result jsonb;input jsonb:=jsonb_build_object('orgId',p_org,'repositoryId',p_repository,'fullName',p_name,'installationId',p_installation);
 begin
 if not exists(select 1 from public.team_organization_owners o join public.team_memberships m on m.org_id=o.org_id and m.user_id=o.user_id where o.org_id=p_org and o.user_id=p_user and m.active) then raise exception 'organization owner required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_user::text||p_request::text,8));
 select * into prior from team_private.onboarding_requests where user_id=p_user and request_id=p_request;
 if found then if prior.kind<>'repository' or prior.input<>input then raise exception 'request conflict' using errcode='40001';end if;return prior.result;end if;
 insert into public.team_repositories(org_id,repository_id,full_name,installation_id,enabled)values(p_org,p_repository,p_name,p_installation,true)
 on conflict(org_id,repository_id)do update set full_name=excluded.full_name,installation_id=excluded.installation_id,enabled=true;
 result:=jsonb_build_object('orgId',p_org,'repositoryId',p_repository,'fullName',p_name);
 insert into team_private.onboarding_requests values(p_user,p_request,'repository',input,result);return result;
 end $$;
revoke execute on function public.team_create_organization(uuid,text,uuid),public.team_register_repository(uuid,uuid,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.team_create_organization(uuid,text,uuid),public.team_register_repository(uuid,uuid,text,text,text,uuid) to service_role;

create function public.team_find_shared_proposal(p_request uuid,p_digest text,p_actor uuid) returns jsonb language plpgsql security definer set search_path='' as $$
 declare r team_private.proposal_share_requests;p public.team_fix_proposals;
 begin
 select * into r from team_private.proposal_share_requests where user_id=p_actor and request_id=p_request;
 if not found then return null;end if;
 if r.bundle_digest<>p_digest then raise exception 'request conflict' using errcode='40001';end if;
 select * into p from public.team_fix_proposals where id=r.proposal_id;
 if not team_private.can_read(p.org_id,p.repository_id,p_actor) then raise exception 'forbidden' using errcode='42501';end if;
 return to_jsonb(p);
 end $$;

create function public.team_share_proposal(p_bundle jsonb,p_digest text,p_request uuid,p_actor uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare u uuid:=p_actor;k jsonb:=p_bundle->'key';existing public.team_fix_proposals;result public.team_fix_proposals;prior jsonb;f jsonb;c jsonb;
 begin
 if not team_private.can_read((k->>'orgId')::uuid,k->>'repositoryId',u) then raise exception 'forbidden' using errcode='42501'; end if;
 if p_digest is distinct from team_private.sha(p_bundle) then raise exception 'bundle digest mismatch';end if;
 perform pg_advisory_xact_lock(hashtextextended(u::text||p_request::text,2));
 prior:=public.team_find_shared_proposal(p_request,p_digest,p_actor);if prior is not null then return prior;end if;
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

create function public.team_decide_proposal(p_id uuid,p_digest text,p_decision text,p_request uuid,p_confirmed boolean,p_actor uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
 declare u uuid:=p_actor;p public.team_fix_proposals;head public.team_pr_heads;g public.team_repository_grants;d public.team_proposal_decisions;
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

revoke execute on function public.team_find_shared_proposal(uuid,text),public.team_share_proposal(jsonb,text,uuid),public.team_decide_proposal(uuid,text,text,uuid,boolean) from public,anon,authenticated;
revoke execute on function public.team_find_shared_proposal(uuid,text,uuid),public.team_share_proposal(jsonb,text,uuid,uuid),public.team_decide_proposal(uuid,text,text,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.team_find_shared_proposal(uuid,text,uuid),public.team_share_proposal(jsonb,text,uuid,uuid),public.team_decide_proposal(uuid,text,text,uuid,boolean,uuid) to service_role;
