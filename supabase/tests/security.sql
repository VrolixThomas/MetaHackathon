\set ON_ERROR_STOP on
begin;
insert into auth.users values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003');
insert into public.team_organizations values('10000000-0000-4000-8000-000000000001','Controlled test org');
insert into public.team_memberships values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true),('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',true);
insert into public.team_repositories values('10000000-0000-4000-8000-000000000001','42','test/repo','7',true);
insert into public.team_repository_grants values('10000000-0000-4000-8000-000000000001','42','00000000-0000-4000-8000-000000000001','101',now(),now()+interval '60 seconds'),('10000000-0000-4000-8000-000000000001','42','00000000-0000-4000-8000-000000000002','102',now(),now()+interval '60 seconds');
create function pg_temp.assert(value boolean,label text) returns void language plpgsql as $$begin if value is distinct from true then raise exception 'FAIL: %',label;end if;end$$;
-- Same immutable key both authorized users load, no personal fields in canonical artifact.
select jsonb_build_object('orgId','10000000-0000-4000-8000-000000000001','repositoryId','42','prNumber',1,'baseSha',repeat('a',40),'headSha',repeat('b',40),'contextDigest',repeat('c',64),'analysisVersion','test-v1') as key \gset
insert into public.team_review_artifacts(key,org_id,repository_id,review,digest) values(:'key','10000000-0000-4000-8000-000000000001','42',jsonb_build_object('pr',jsonb_build_object('baseSha',repeat('a',40),'headSha',repeat('b',40),'number',1)),repeat('d',64));
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.assert((select count(*)=1 from public.team_review_artifacts),'user A reads canonical artifact');
select public.team_write_progress(:'key',jsonb_build_object('key',:'key'::jsonb,'revision',0,'cursor','a.ts','notes','private A'),0,'20000000-0000-4000-8000-000000000001');
select public.team_write_progress(:'key',jsonb_build_object('key',:'key'::jsonb,'revision',0,'cursor','a.ts','notes','private A'),0,'20000000-0000-4000-8000-000000000001');
select pg_temp.assert((select revision=1 from public.team_review_progress),'retry idempotent');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.assert((select count(*)=1 from public.team_review_artifacts),'user B reads same canonical artifact');
select pg_temp.assert((select count(*)=0 from public.team_review_progress),'user B cannot read A notes/cursor');
select public.team_write_progress(:'key',jsonb_build_object('key',:'key'::jsonb,'revision',0,'cursor','b.ts','notes','private B'),0,'20000000-0000-4000-8000-000000000002');
select pg_temp.assert((select progress->>'notes'='private B' from public.team_review_progress),'user B independent progress');
do $$begin begin insert into public.team_repository_grants values('10000000-0000-4000-8000-000000000001','42',auth.uid(),'bad',now(),now()+interval '1 second');raise exception 'unexpected escalation';exception when insufficient_privilege then null;end;end$$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select pg_temp.assert((select count(*)=0 from public.team_review_artifacts),'nonmember denied');
reset role;
update public.team_repository_grants set checked_at=now()-interval '61 seconds',expires_at=now()-interval '1 second' where user_id='00000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.assert((select count(*)=0 from public.team_review_artifacts),'expired repo grant denied despite membership');
select pg_temp.assert((select count(*)=0 from public.team_review_progress),'expired repo grant hides private progress');
reset role;
update public.team_memberships set active=false where user_id='00000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.assert((select count(*)=0 from public.team_review_artifacts),'revoked member denied despite fresh repo grant');
reset role;
-- Raw webhook redelivery and lease fencing, all writes server-only.
select public.team_ingest_webhook('30000000-0000-4000-8000-000000000001',repeat('e',64),'10000000-0000-4000-8000-000000000001','42','7','{}');
select public.team_ingest_webhook('30000000-0000-4000-8000-000000000001',repeat('e',64),'10000000-0000-4000-8000-000000000001','42','7','{}');
select pg_temp.assert((select count(*)=1 from public.team_webhooks),'duplicate webhook fenced');
select public.team_claim('webhook',120)->>'lease_token' as lease \gset
update public.team_webhooks set lease_until=now()-interval '1 second';
select public.team_claim('webhook',120)->>'lease_token' as next_lease \gset
select pg_temp.assert(:'lease'<>:'next_lease','lease fencing token rotated');
select pg_temp.assert(not public.team_renew('webhook','30000000-0000-4000-8000-000000000001',:'lease',120),'stale owner cannot renew');
select public.team_enqueue_preparation(:'key',jsonb_build_object('pr',jsonb_build_object('baseSha',repeat('a',40),'headSha',repeat('b',40))),'30000000-0000-4000-8000-000000000001',:'next_lease');
select public.team_claim('preparation',120)->>'lease_token' as prep_lease \gset
select id as prep_id from public.team_preparation_jobs \gset
select public.team_finish_preparation(:'prep_id',:'prep_lease',jsonb_build_object('pr',jsonb_build_object('baseSha',repeat('a',40),'headSha',repeat('b',40),'number',1)),repeat('f',64));
select pg_temp.assert((select digest=repeat('d',64) from public.team_review_artifacts),'canonical result never overwritten');
-- Source-sensitive consent cannot bypass the HTTP verifier through a user JWT.
select pg_temp.assert(not has_function_privilege('authenticated','public.team_share_proposal(jsonb,text,uuid)','execute'),'legacy direct share denied');
select pg_temp.assert(not has_function_privilege('authenticated','public.team_share_proposal(jsonb,text,uuid,uuid)','execute'),'actor direct share denied');
select pg_temp.assert(not has_function_privilege('authenticated','public.team_decide_proposal(uuid,text,text,uuid,boolean)','execute'),'legacy direct decision denied');
select pg_temp.assert(not has_function_privilege('authenticated','public.team_decide_proposal(uuid,text,text,uuid,boolean,uuid)','execute'),'actor direct decision denied');
-- Proposal bundle and author decision isolation.
update public.team_memberships set active=true;
update public.team_repository_grants set checked_at=now(),expires_at=now()+interval '60 seconds';
insert into public.team_pr_heads values('10000000-0000-4000-8000-000000000001','42',1,repeat('b',40),'102',now());
insert into public.team_feedback_revisions values('10000000-0000-4000-8000-000000000001','42',1,'pull-review-comment','9','2026-11-01T00:00:00Z',encode(extensions.digest('fix this','sha256'),'hex'),now());
select jsonb_build_array(jsonb_build_object('path','a.ts','before',jsonb_build_object('text','old','sha256',encode(extensions.digest('old','sha256'),'hex')),'after',jsonb_build_object('text','new','sha256',encode(extensions.digest('new','sha256'),'hex')))) as files \gset
select jsonb_build_object('key',:'key'::jsonb,'baseSha',repeat('b',40),'candidateSha',repeat('f',40),'feedback',jsonb_build_object('kind','pull-review-comment','id','9','revision','2026-11-01T00:00:00Z','body','fix this','bodyDigest',encode(extensions.digest('fix this','sha256'),'hex')),'files',:'files'::jsonb,'sourcesDigest',team_private.sha(:'files'::jsonb),'patch',jsonb_build_object('text','-old +new','sha256',encode(extensions.digest('-old +new','sha256'),'hex')),'checks','[]'::jsonb,'checksDigest',team_private.sha('[]'::jsonb),'provenance','reported-local-candidate') as bundle \gset
select team_private.sha(:'bundle'::jsonb) as bundle_digest \gset
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
reset role;
set local role service_role;
select public.team_share_proposal(:'bundle',:'bundle_digest','40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001')->>'id' as proposal_id \gset
reset role;
set local role authenticated;
reset role;
set local role service_role;
select public.team_share_proposal(:'bundle',:'bundle_digest','40000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001');
reset role;
set local role authenticated;
select pg_temp.assert((select count(*)=1 from public.team_fix_proposals),'exact proposal retry dedup');
do $$begin begin perform public.team_decide_proposal((select id from public.team_fix_proposals limit 1),(select bundle_digest from public.team_fix_proposals limit 1),'accept','50000000-0000-4000-8000-000000000001',true);raise exception 'unexpected nonauthor decision';exception when insufficient_privilege then null;end;end$$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.assert((select bundle_digest=team_private.sha(bundle) from public.team_fix_proposals),'user B sees exact shared bytes/hash');
reset role;
set local role service_role;
select public.team_share_proposal(:'bundle',:'bundle_digest','40000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002');
reset role;
set local role authenticated;
select pg_temp.assert((select count(*)=1 from public.team_fix_proposals),'two owners reuse same exact bundle');
reset role;
set local role service_role;
select pg_temp.assert(public.team_find_shared_proposal('40000000-0000-4000-8000-000000000002',:'bundle_digest','00000000-0000-4000-8000-000000000002')->>'id'=:'proposal_id','second owner has its own durable retry receipt');
reset role;
set local role authenticated;
reset role;
set local role service_role;
do $$begin begin perform public.team_find_shared_proposal('40000000-0000-4000-8000-000000000002',repeat('0',64),'00000000-0000-4000-8000-000000000002');raise exception 'request identity rebound';exception when serialization_failure then null;end;end$$;
reset role;
set local role authenticated;

reset role;
set local role service_role;
select public.team_decide_proposal(:'proposal_id',:'bundle_digest','accept','50000000-0000-4000-8000-000000000002',true,'00000000-0000-4000-8000-000000000002');
reset role;
set local role authenticated;
reset role;
set local role service_role;
select public.team_decide_proposal(:'proposal_id',:'bundle_digest','accept','50000000-0000-4000-8000-000000000002',true,'00000000-0000-4000-8000-000000000002');
reset role;
set local role authenticated;
select pg_temp.assert((select count(*)=1 from public.team_proposal_decisions),'author decision exact retry dedup');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select pg_temp.assert((select count(*)=0 from public.team_fix_proposals),'nonmember cannot read proposal bytes');
select pg_temp.assert((select count(*)=0 from public.team_proposal_decisions),'nonmember cannot read decisions');
reset role;
update public.team_repository_grants set checked_at=now()-interval '61 seconds',expires_at=now()-interval '1 second' where user_id='00000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.assert((select count(*)=0 from public.team_fix_proposals),'revoked repo user cannot retrieve bundle');
reset role;
-- Tampered source hash is rejected by the DB independently of HTTP schema checks.
do $$declare b jsonb;begin select bundle into b from public.team_fix_proposals limit 1;b:=jsonb_set(b,'{files,0,after,text}','"tampered"');begin insert into public.team_fix_proposals(org_id,repository_id,key,owner_id,request_id,bundle,bundle_digest) values('10000000-0000-4000-8000-000000000001','42',b->'key','00000000-0000-4000-8000-000000000001',gen_random_uuid(),b,team_private.sha(b));raise exception 'tampered source accepted';exception when check_violation then null;end;end$$;
-- Expired final-attempt claims become terminal, never remain invisible forever.
update public.team_preparation_jobs set state='leased',attempts=5,lease_token=gen_random_uuid(),lease_until=now()-interval '1 second';
select public.team_claim('preparation',120);
select pg_temp.assert((select state='failed' from public.team_preparation_jobs),'exhausted crash visible failure');
update public.team_repository_grants set checked_at=now(),expires_at=now()+interval '60 seconds';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.assert((select state='failed' from public.team_preparation_jobs),'authorized status exposes actual failure');
select public.team_retry_preparation(:'key','60000000-0000-4000-8000-000000000001');
select pg_temp.assert((select state='queued' from public.team_preparation_jobs),'explicit retry resets terminal failure');
reset role;
update public.team_preparation_jobs set state='leased',attempts=1,lease_token=gen_random_uuid(),lease_until=now()+interval '1 minute';
set local role authenticated;
select public.team_retry_preparation(:'key','60000000-0000-4000-8000-000000000001');
select pg_temp.assert((select state='leased' from public.team_preparation_jobs),'duplicate retry cannot reset a new active lease');
reset role;

reset role;
set local role service_role;
select public.team_create_organization('00000000-0000-4000-8000-000000000001','Created org','70000000-0000-4000-8000-000000000001')->>'id' as new_org \gset
select pg_temp.assert(public.team_create_organization('00000000-0000-4000-8000-000000000001','Created org','70000000-0000-4000-8000-000000000001')->>'id'=:'new_org','org creation idempotent');
insert into public.team_memberships values(:'new_org','00000000-0000-4000-8000-000000000002',true);
select public.team_register_repository('00000000-0000-4000-8000-000000000001',:'new_org','43','test/second','7','70000000-0000-4000-8000-000000000002');
do $$begin begin perform public.team_register_repository('00000000-0000-4000-8000-000000000002',(select id from public.team_organizations where name='Created org'),'44','test/forged','7',gen_random_uuid());raise exception 'member registered repo';exception when insufficient_privilege then null;end;end$$;
reset role;
set local role authenticated;
-- Even with fresh server head/source witnesses, direct calls cannot record stale consent.
do $$begin begin perform public.team_decide_proposal((select id from public.team_fix_proposals limit 1),repeat('a',64),'accept',gen_random_uuid(),true,'00000000-0000-4000-8000-000000000002');raise exception 'direct actor RPC permitted';exception when insufficient_privilege then null;end;end$$;
reset role;
rollback;
