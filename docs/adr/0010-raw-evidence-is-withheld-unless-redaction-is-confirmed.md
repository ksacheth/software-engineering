# Raw evidence is withheld unless redaction is confirmed

F.6 requires the request/response pairs behind a finding to be retained with
credentials, session tokens and recognised personal data redacted. Redaction
happens where evidence is written, in the detector pipeline, and
`finding_evidence.isRedacted` is set only once that step has completed. The
column defaults to `false`.

The findings API therefore returns request and response headers and bodies, the
curl command and the extracted snippet only when `isRedacted` is `true`. A row
that is not marked redacted is reported as withheld, never shown. This is the
same shape as ADR-0004: when the system cannot confirm the safe condition, it
refuses rather than assuming. A detector that forgets to set the flag produces
evidence nobody can see, which is a visible bug; the alternative produces a
leaked session token, which is not.

Raw evidence is also withheld from VIEWER, enforced by the API rather than by
the dashboard hiding it. The personas in the SRS give VIEWER a posture summary,
and the v1.1 role matrix denied it raw evidence. A VIEWER still sees everything
else about a finding: description, remediation, classification, location and
triage history.

Purged evidence (`isPurged`) is reported as purged with its date. The payload
columns are already null by then, so there is nothing to withhold.
