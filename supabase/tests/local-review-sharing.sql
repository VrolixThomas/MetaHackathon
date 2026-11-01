\set ON_ERROR_STOP on
-- MET-72: root runs after every ordered migration in isolated PostgreSQL.
-- Controlled source fences stand in for fresh HTTP verification, tested separately.
begin;
create function pg_temp.assert(value boolean,label text) returns void language plpgsql as $$
 begin if value is distinct from true then raise exception 'FAIL: %',label;end if;end $$;
create function pg_temp.expect_state(command text,expected text,label text) returns void language plpgsql as $$
 begin
  begin execute command;
  exception when others then if sqlstate=expected then return;end if;raise;
  end;
  raise exception 'FAIL: % (expected SQLSTATE %)',label,expected;
 end $$;
insert into auth.users values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003');
insert into public.team_organizations values
 ('10000000-0000-4000-8000-000000000001','Local A'),
 ('10000000-0000-4000-8000-000000000002','Local B'),
 ('10000000-0000-4000-8000-000000000003','Local C');
insert into public.team_memberships values
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true),
 ('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',true),
 ('10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',true),
 ('10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000001',true);
insert into public.team_organization_owners values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001');
-- Registration stays service-only. NULL is a real local-only registration, no fake installation ID.
set local role service_role;
select public.team_register_repository('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','42','test/repo',null,'60000000-0000-4000-8000-000000000001');
select public.team_register_repository('00000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','42','test/repo',null,'60000000-0000-4000-8000-000000000001');
select pg_temp.assert((select installation_id is null and enabled from public.team_repositories),'nullable registration persisted');
select pg_temp.expect_state($q$select public.team_register_repository('00000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','42','test/repo',null,'60000000-0000-4000-8000-000000000002')$q$,'42501','member without owner cannot register');
reset role;
insert into public.team_repositories(org_id,repository_id,full_name,installation_id) values
 ('10000000-0000-4000-8000-000000000002','42','test/repo',null),
 ('10000000-0000-4000-8000-000000000003','42','test/repo',null);
insert into public.team_repository_grants values
 ('10000000-0000-4000-8000-000000000001','42','00000000-0000-4000-8000-000000000001','101',now(),now()+interval '60 seconds'),
 ('10000000-0000-4000-8000-000000000001','42','00000000-0000-4000-8000-000000000002','102',now(),now()+interval '60 seconds'),
 ('10000000-0000-4000-8000-000000000002','42','00000000-0000-4000-8000-000000000003','103',now(),now()+interval '60 seconds'),
 ('10000000-0000-4000-8000-000000000003','42','00000000-0000-4000-8000-000000000001','101',now(),now()+interval '60 seconds');
create temp table local_samples(name text primary key,key jsonb not null,review jsonb not null,digest text);
insert into local_samples(name,key,review)
 select label,jsonb_build_object('orgId',o,'repositoryId','42','prNumber',n,'baseSha',repeat('a',40),'headSha',repeat('b',40),'contextDigest',repeat('c',64),'analysisVersion','test-v1'),
 jsonb_build_object('id','reported-review','version',1,'pr',jsonb_build_object('id','test/repo#'||n,'repository','test/repo','number',n,'url','https://github.com/test/repo/pull/'||n,'title','Exact PR','author','author','baseSha',repeat('a',40),'headSha',repeat('b',40)),
 'createdAt','2026-11-01T00:00:00Z','summary','Reported local inference','orderRationale','Read source',
 'files',jsonb_build_array(jsonb_build_object('path','a.ts','reason','Read source','summary','Changed behavior','suggestedComments','[]'::jsonb)),
 'coverage','complete','evidence','inferred-from-github')
 from (values
 ('a','10000000-0000-4000-8000-000000000001',1),
 ('a-other-key','10000000-0000-4000-8000-000000000001',2),
 ('legacy','10000000-0000-4000-8000-000000000001',3),
 ('b','10000000-0000-4000-8000-000000000002',1),
 ('c','10000000-0000-4000-8000-000000000003',1)) as fixture(label,o,n);
insert into local_samples(name,key,review) select 'competing',key,review||'{"summary":"Different local inference"}'::jsonb from local_samples where name='a';
update local_samples set digest=team_private.sha(jsonb_build_object('key',key,'review',review));
grant select on local_samples to authenticated,anon,service_role;
-- Invoker helper preserves the real app role. No security definer test bypasses.
create function pg_temp.publish_sample(actor uuid,sample text,request uuid) returns jsonb language sql as $$
 select public.team_publish_local_review(actor,key,review,digest,request) from pg_temp.local_samples where name=sample
$$;
insert into public.team_pr_heads(org_id,repository_id,pr_number,head_sha,github_author_id,checked_at,base_sha,context_digest)
 select (key->>'orgId')::uuid,'42',(key->>'prNumber')::integer,repeat('b',40),'101',now(),repeat('a',40),repeat('c',64)
 from local_samples where name<>'competing';
insert into public.team_review_artifacts(key,org_id,repository_id,review,digest)
 select key,(key->>'orgId')::uuid,'42',review,digest from local_samples where name='legacy';

select pg_temp.assert(not has_function_privilege('anon','public.team_publish_local_review(uuid,jsonb,jsonb,text,uuid)','execute'),'anon publish revoked');
select pg_temp.assert(not has_function_privilege('authenticated','public.team_publish_local_review(uuid,jsonb,jsonb,text,uuid)','execute'),'authenticated publish revoked');
select pg_temp.assert(has_function_privilege('service_role','public.team_publish_local_review(uuid,jsonb,jsonb,text,uuid)','execute'),'service-only publish granted');
select pg_temp.assert((select relrowsecurity from pg_class where oid='team_private.local_review_requests'::regclass),'new private ledger RLS enabled');
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','a','61000000-0000-4000-8000-000000000001')$q$,'42501','user cannot bypass HTTP source verification');
select pg_temp.expect_state('select * from team_private.local_review_requests','42501','private ledger unreadable');
select pg_temp.expect_state('insert into team_private.local_review_requests select null,null,null,null,now()','42501','private ledger unforgeable');
select pg_temp.expect_state('update public.team_review_artifacts set prepared_by=auth.uid()','42501','client cannot forge attribution');
select pg_temp.expect_state('delete from public.team_review_artifacts','42501','client cannot delete canonical artifact');
reset role;
set local role anon;
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','a','61000000-0000-4000-8000-000000000001')$q$,'42501','anon cannot publish for another actor');
reset role;
set local role service_role;
select pg_temp.assert(pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','a','61000000-0000-4000-8000-000000000001')->>'origin'='local','local origin server derived');
select pg_temp.assert(pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','a','61000000-0000-4000-8000-000000000001')->>'prepared_by'='00000000-0000-4000-8000-000000000001','preparer server derived and exact retry');
select pg_temp.assert((select count(*)=1 from team_private.local_review_requests),'retry does not duplicate private ledger');
select pg_temp.assert((select count(*)=0 from public.team_preparation_jobs) and (select count(*)=0 from public.team_webhooks),'publish creates no hosted jobs');
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','competing','61000000-0000-4000-8000-000000000001')$q$,'40001','same request cannot bind another review');
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','a-other-key','61000000-0000-4000-8000-000000000001')$q$,'40001','same request cannot bind another key');
select pg_temp.assert(pg_temp.publish_sample('00000000-0000-4000-8000-000000000002','competing','61000000-0000-4000-8000-000000000001')->>'digest'=(select digest from local_samples where name='a'),'different actor has private request namespace and receives first canonical artifact');
select pg_temp.assert(pg_temp.publish_sample('00000000-0000-4000-8000-000000000002','competing','61000000-0000-4000-8000-000000000001')->>'prepared_by'='00000000-0000-4000-8000-000000000001','competing retries retain first preparer');
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000002','a','61000000-0000-4000-8000-000000000001')$q$,'40001','losing input stays bound to its submitted digest, not canonical output');
select pg_temp.assert((select input_digest=(select digest from local_samples where name='competing') from team_private.local_review_requests where user_id='00000000-0000-4000-8000-000000000002'),'private ledger preserves competing input');
select pg_temp.assert(pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','legacy','61000000-0000-4000-8000-000000000003')->'origin'='null'::jsonb,'legacy canonical origin stays unknown');
select pg_temp.expect_state('update public.team_review_artifacts set origin=origin','P0001','canonical artifact stays immutable for service role');
select pg_temp.expect_state('delete from public.team_review_artifacts','P0001','canonical artifact deletion remains forbidden');
select pg_temp.expect_state($q$select public.team_publish_local_review('00000000-0000-4000-8000-000000000001',key,review,repeat('0',64),'62000000-0000-4000-8000-000000000001') from pg_temp.local_samples where name='a'$q$,'P0001','database checks exact artifact digest');
select pg_temp.expect_state($q$select public.team_publish_local_review(null,key,review,digest,'62000000-0000-4000-8000-000000000001') from pg_temp.local_samples where name='a'$q$,'P0001','null actor rejected');
select pg_temp.expect_state($q$select public.team_publish_local_review('00000000-0000-4000-8000-000000000001',key,review,digest,null) from pg_temp.local_samples where name='a'$q$,'P0001','null request rejected');
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','b','61000000-0000-4000-8000-000000000002')$q$,'42501','forged foreign org key with identical repository cannot publish');
reset role;

-- Freshness applies before an already bound request returns, not just first publication.
update public.team_memberships set active=false where org_id='10000000-0000-4000-8000-000000000001' and user_id='00000000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000002','competing','61000000-0000-4000-8000-000000000001')$q$,'42501','revoked member cannot retry');
reset role;
update public.team_memberships set active=true;
update public.team_repository_grants set checked_at=now()-interval '61 seconds',expires_at=now()-interval '1 second' where org_id='10000000-0000-4000-8000-000000000001' and user_id='00000000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000002','competing','61000000-0000-4000-8000-000000000001')$q$,'42501','expired repository grant cannot retry');
reset role;
update public.team_repository_grants set checked_at=now()+interval '1 second',expires_at=now()+interval '61 seconds' where org_id='10000000-0000-4000-8000-000000000001' and user_id='00000000-0000-4000-8000-000000000002';
set local role service_role;
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000002','competing','61000000-0000-4000-8000-000000000001')$q$,'42501','future checked grant cannot establish current authorization');
reset role;
update public.team_repository_grants set checked_at=now(),expires_at=now()+interval '60 seconds';
update public.team_repositories set enabled=false where org_id='10000000-0000-4000-8000-000000000001';
set local role service_role;
select pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','a','61000000-0000-4000-8000-000000000001')$q$,'42501','disabled repository blocks replay');
reset role;
update public.team_repositories set enabled=true;

-- Move each independently verified source field, keeping the other fields unchanged.
do $$
 declare change text;
 begin
 foreach change in array array[
  'head_sha=repeat(''f'',40)', 'base_sha=repeat(''f'',40)', 'context_digest=repeat(''f'',64)',
  'checked_at=now()-interval ''61 seconds''', 'checked_at=now()+interval ''1 second''',
  'base_sha=null', 'context_digest=null'
 ] loop
  execute 'update public.team_pr_heads set '||change||' where org_id=''10000000-0000-4000-8000-000000000001'' and pr_number=1';
  -- Switch to the actual server role for the security-definer RPC, not a superuser assertion.
  execute 'set local role service_role';
  perform pg_temp.expect_state($q$select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','a','61000000-0000-4000-8000-000000000001')$q$,'40001','stale head/base/context cannot retry: '||change);
  execute 'reset role';
  update public.team_pr_heads set head_sha=repeat('b',40),base_sha=repeat('a',40),context_digest=repeat('c',64),checked_at=now();
 end loop;
 end $$;
set local role service_role;
select pg_temp.publish_sample('00000000-0000-4000-8000-000000000003','b','61000000-0000-4000-8000-000000000002');
select pg_temp.publish_sample('00000000-0000-4000-8000-000000000001','c','61000000-0000-4000-8000-000000000004');
reset role;
-- Existing RLS and private progress remain in force for local artifacts and attribution.
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.assert((select count(*)=3 from public.team_review_artifacts),'multi-org user reads only A + C, including legacy A');
select pg_temp.assert(not exists(select 1 from public.team_review_artifacts where org_id='10000000-0000-4000-8000-000000000002'),'same repository ID in foreign tenant hidden');
select public.team_write_progress((select key from local_samples where name='a'),jsonb_build_object('key',(select key from local_samples where name='a'),'revision',0,'cursor','a.ts','visited','[]'::jsonb,'notes','private A','paused',false),0,'63000000-0000-4000-8000-000000000001');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.assert((select count(*)=2 from public.team_review_artifacts),'second actor reads A only');
select pg_temp.assert(not exists(select 1 from public.team_review_progress),'other actor notes stay private');
select public.team_write_progress((select key from local_samples where name='a'),jsonb_build_object('key',(select key from local_samples where name='a'),'revision',0,'cursor','a.ts','visited','[]'::jsonb,'notes','private B','paused',false),0,'63000000-0000-4000-8000-000000000002');
select pg_temp.assert((select count(*)=1 and bool_and(progress->>'notes'='private B') from public.team_review_progress),'only own private progress visible');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select pg_temp.assert((select count(*)=1 and bool_and(org_id='10000000-0000-4000-8000-000000000002') from public.team_review_artifacts),'disjoint tenant sees only B');
select pg_temp.assert(not exists(select 1 from public.team_review_progress),'third actor sees no other private progress');
reset role;
rollback;
