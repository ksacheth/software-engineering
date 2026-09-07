# The triage projection is written by a trigger, not by the application

Triage lives in two tables. `finding_triage_history` is the append-only record
of every state transition. `target_finding_triage` holds exactly one row per
`(targetId, findingFingerprint)` with the current state, and is maintained by an
`AFTER INSERT` trigger on the history table.

The projection exists for NFR-PERF-1. Deriving current triage state from history
at read time needs `DISTINCT ON` over an unbounded number of events to produce a
bounded answer, and worse, filtering by triage status — which F.6 and F.7 both
require — cannot be indexed at all, because "is this finding a false positive"
is a property of the latest row rather than of any row.

Writing it from a trigger rather than from application code makes dual-write
skew structurally impossible instead of a code-review discipline. The function
is `SECURITY DEFINER` and `wvs_app` holds only SELECT on the projection, so the
sole way to change triage state is to insert into the history table. History
remains the record of truth; the projection is a derived cache and is
rebuildable from history alone, which `lastHistoryId` makes checkable.
