---
status: proposed
---

# The kill switch aborts scans through their rows and a flag the Scope Guard reads

F.8 requires an administrator kill switch that halts all running scans
system-wide. Engaging it does two things. The API moves every `QUEUED`,
`RUNNING` and `PAUSED` scan to `ABORTED_SAFETY`, with one audit record per scan,
and refuses starts, resumes and reconciler re-deliveries while the switch is
engaged. It also sets the `scan.kill_switch` system setting. The Scope Guard
reads that setting as its first check, before verification status, and refuses
every outbound request while it is set.

The rows are ADR-0007 applied unchanged. A worker reads `ABORTED_SAFETY` at its
next checkpoint and exits, and the scan ends in a correct, final and visible
state that releases its quota. The rows are not enough on their own, because
they are written at one instant and a scan can slip past it: a row being
inserted as the switch is engaged, or a worker that has not yet reached its next
checkpoint. The flag closes that gap. It is read per request, so once it is set
no request leaves the system, whatever any row says.

`ABORTED_SAFETY` is final, and releasing the switch restarts nothing. A kill
switch is engaged because something is wrong, and bringing every scan back on
release would repeat whatever caused it. Users start new scans once it is off.

## Considered options

- **Pause everything and resume on release.** Rejected for the reason above,
  and because a paused scan holds quota for as long as the switch stays on.
- **A Redis broadcast to workers.** Rejected for the reasons ADR-0007 gives for
  control delivery: pub/sub has no delivery guarantee, and a worker that misses
  the message keeps crawling.
- **The flag alone.** Requests would stop, but rows would still read `RUNNING`,
  holding quota and misreporting state until each worker happened to notice.

## Consequences

- The Scope Guard must fail closed: if it cannot read the setting, it refuses
  the request. It may cache the value only briefly enough that a set flag stops
  requests within the five seconds F.3 allows for cancellation.
- The flag check lives on the enforcement side of F.8 (Deepthi) while the switch
  lives on the administration side (Sacheth). This ADR stays `proposed` until
  both agree to the setting's name and the fail-closed rule.
