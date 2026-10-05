# Report files follow their author, and share links are hashed

A report is rendered once, by a queue worker, and the file is then served many
times, so what it holds is decided at generation and cannot depend on who
downloads it later. Raw evidence in a Technical Report therefore follows
ADR-0010 for the report's author at generation time: shown only when redaction
is confirmed, and never for an author who is a VIEWER. An author whose account
no longer exists is treated as a VIEWER. The Executive Summary never loads
evidence at all.

Because the file is fixed, the download is checked as well. A report that
holds any raw evidence (`includesEvidence`) is refused to a VIEWER whoever
generated it, so a colleague's Technical Report cannot become a way around
ADR-0010.

Evidence has a retention period (F.6, C.7), and a file that copied it must not
outlive it. A report records the earliest expiry of the evidence it holds and
is not served, directly or by link, after that moment. Purging the files
themselves belongs with the retention job (#8).

A share link lets anyone holding it download one file, without a session,
until it expires. Creating one needs a write role, because it hands the file
outside the organisation. A link lasts 1 to 30 days and never past the report's
evidence expiry. Only the SHA-256 of the token is stored, the same treatment as
any other credential, so a read of the database yields no working links. The
token is shown once, when the link is made. A new link replaces the old one, and
every way a link can fail answers 404, so a guessed, expired or revoked token
look the same.

Rejected: letting a link serve only Executive Summaries. A writer can already
download a Technical Report and send it on, so the restriction would add
friction without protecting anything, while the audit record of the share would
be lost.
