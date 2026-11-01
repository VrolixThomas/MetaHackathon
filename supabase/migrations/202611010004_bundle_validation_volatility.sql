-- Timestamp casts in the exact-bundle validator can depend on session settings.
-- Preserve its checks and access controls while declaring the correct volatility.
alter function team_private.valid_bundle(jsonb) stable;
