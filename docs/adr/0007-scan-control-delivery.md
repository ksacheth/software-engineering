# Scan lifecycle controls are delivered through the scan row

[ADR-0006](0006-scan-execution-contract.md) defines both directions of the
F.3 contract: the API enqueues a thin payload, and the orchestrator publishes
events back over Redis. It says nothing about how a pause, resume or cancel
reaches a job that is already running, and the gap is not academic. `controlScan`
writes the new status to `scan_jobs` and stops there, so today a user can be
told a scan is `CANCELLED` while a worker keeps crawling.

The row is the signal. The orchestrator re-reads `status` at each progress
checkpoint, which F.3 already requires every two seconds, and a `PAUSED` or
`CANCELLED` row means write the checkpoint and exit. No new channel, no new
infrastructure.

This is ADR-0006's own argument applied to lifecycle rather than configuration.
That ADR keeps the row as the single source of truth because a second copy can
drift; the same holds here, with the added property that the database is durable.
A worker that picks its job up late still reads `CANCELLED` before it issues a
request, a control issued while the API was restarting is not lost, and a worker
that dies mid-scan leaves a row that still says what the user asked for.

The cost is latency bounded by one checkpoint. That bound is the point: it gives
"cancelled" a defined meaning in the interface, rather than an unspecified one.

## What each side owns

The orchestrator owns noticing. The API owns sending, and two of its obligations
are easy to mistake for the worker's:

Cancelling a scan that has not started must also remove its BullMQ job. The job
is keyed by scan id, so a cancellation issued while the scan is `QUEUED` would
otherwise sit in Redis and execute later against a scan the user believes is
finished.

Resuming must re-enqueue, with `attempt` incremented. A paused worker has exited,
so nothing else will ever restart it, and only the API knows the user asked. This
is what ADR-0006 introduced `attempt` for: it is 1-based so a resumed scan
continues from its checkpoint rather than crawling the target a second time.
Resume also re-answers C.2 before it enqueues, because a pause can outlive a
verification.

## Rejected alternatives

**A Redis control channel.** ADR-0006 forbids side effects on the event channel
because it is fan-out: every API instance receives every message. A control has
the opposite shape, since it must reach exactly the one worker holding the job.
Pub/sub also has no delivery guarantee, so a worker that is mid-request or
restarting misses the message and carries on crawling, which is the worst
available failure for a cancel. Defending that needs the row as a backstop, and
once the row is the backstop the channel earns nothing but a second mechanism to
keep correct.

**A worker that stays alive across a pause.** It would make resume a local
matter, with no re-enqueue. It also pins a BullMQ worker slot for as long as the
pause lasts, which may be days, and a job that reports no progress for that long
fights the queue's own stall detection. A scan parked for a week must not hold a
worker; it should hold nothing but a row.
