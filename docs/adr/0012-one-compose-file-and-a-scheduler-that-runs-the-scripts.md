# One compose file, and a scheduler that runs the maintenance scripts

DC-7 asks for one orchestration definition serving both local development and
the demonstration deployment. `docker-compose.yml` is that file. Its default
services are the stores development needs (Postgres, Redis, Mailpit), so
`docker compose up -d` beside `bun run dev` is unchanged; the `app` profile adds
the system itself: a one-shot `migrate`, the `api`, a `report-worker`, a
`scheduler` and the `web` nginx. One `app` image runs every Bun process, chosen
by command, because Bun runs the TypeScript sources and there is nothing to
build per process.

Maintenance (`email:retry`, `scans:reconcile`, `purge:retention`) must run in a
deployment without anyone invoking it. The `scheduler` service starts each one
on an interval as its own process, running the same root script an operator
runs by hand. The scripts stay the only definition of a run, including the exit
code that marks dead letters or ended scans, and the purge keeps its owner
credentials to itself rather than sharing a process with the application
role. A run still going at its next turn is skipped, not stacked. There must be
exactly one scheduler.

TLS (NFR-SEC-1) is terminated in front of the stack, not inside it, and the
`web` port is published on loopback only. Inside, nginx reaches the API from a
private bridge address, so the API's `TRUST_PROXY` is `loopback, uniquelocal`,
and Better Auth's trusted proxies are derived from that same setting so the two
cannot disagree about the client address the per-IP rate limits key on. A
public `web` port would let any caller choose its own X-Forwarded-For.

Rejected: BullMQ job schedulers for maintenance. They would allow more than one
scheduler, but the purge would need owner credentials inside a long-running
worker, and a run's outcome would move from an exit code to a log line. Worth
revisiting when `apps/worker` exists. Rejected: cron inside a container. It
drops the environment it runs jobs with and adds a second scheduling language
for one table of three intervals.
