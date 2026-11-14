-- One successful user request increments exactly one usage counter.
-- No invented per-plan audio allowance; paid-tier access is enforced by the server.
ALTER TABLE subscriptions
    ADD COLUMN assist_requests_used bigint NOT NULL DEFAULT 0 CHECK (assist_requests_used >= 0),
    ADD COLUMN audio_requests_used bigint NOT NULL DEFAULT 0 CHECK (audio_requests_used >= 0);
-- These counters measure usage since this migration; historic usage was not stored.
