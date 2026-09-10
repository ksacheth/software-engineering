# Scan execution is decoupled by a thin payload and a Redis event stream

F.3 is split across two owners (`CONTEXT.md`): the scan trigger API and the
BullMQ orchestrator. They never call each other, so the interface between them
is a contract that has to exist before either side is written.

The API enqueues `{ scanJobId, organizationId, attempt }` and nothing else. The
alternative was a payload carrying the whole scan configuration, which would
duplicate `ScanJob`: that row already stores the profile, all five limits, and
the `includedPaths`/`excludedPaths` snapshot F.2 and F.3 require for
reproducibility. A second copy could drift from the row the dashboard displays,
and drift here means a scan that ran with limits nobody can account for
afterwards. The cost is one database read in the worker. `organizationId` is
carried so the worker can label its logs before that read; `attempt` is 1-based
so a resumed scan knows to continue from its checkpoint rather than restart.

Events travel the other way over Redis pub/sub: the orchestrator publishes
`scan.progress`, `scan.finding`, `scan.status` and `scan.warning` to one
channel, and every API instance subscribes and fans out to its own WebSocket
clients. This keeps the API stateless, since no instance holds scan state and
any instance can serve any client (NFR-SCAL-1). The rejected alternative was for
the worker to write progress to Postgres and the API to poll, which cannot hold
the two-second progress interval F.3 requires under load.

Because pub/sub is fan-out, every instance receives every message, so nothing on
that channel may have a side effect: a completion email published there would
send once per instance. Side effects belong at the single point of state
transition, in the worker. The SRS names exactly four events, and those names
are used verbatim as the `type` discriminator; `scan.completed` predates the
SRS, has no consumers, and is removed so that a terminal `scan.status` is the
only signal that a scan has ended.
