-- F.3 resume (ADR-0007): the API re-enqueues a paused scan with the next
-- attempt number, so the orchestrator can tell a resumption from a first
-- delivery and continue from its checkpoint instead of recrawling the target.
--
-- Existing rows default to 1: every scan already in flight has been delivered
-- exactly once, because until now there was no path that re-enqueued one.
ALTER TABLE "scan_job" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
