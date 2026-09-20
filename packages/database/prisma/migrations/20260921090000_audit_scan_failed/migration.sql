-- The reconciler (#6) can end a scan that no user touched: one queued against a
-- target whose authorisation lapsed before anything picked the job up must not
-- be started, and leaving it QUEUED would hold organisation and target capacity
-- indefinitely.
--
-- F.8 wants one audit record per event, and none of the existing scan actions
-- describes this honestly: SCAN_CANCELLED would claim a user cancelled it.
ALTER TYPE "AuditAction" ADD VALUE 'SCAN_FAILED';
