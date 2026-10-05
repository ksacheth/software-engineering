# Email is confirmed with a code, not a link

F.1 asks for registration with email confirmation, and its input list names an
emailed confirmation link. WVS confirms the address with a 6-digit code instead,
typed into the dashboard. The requirement's intent, proving control of the
inbox before any session exists, is unchanged; only the carrier differs, so this
records a deliberate departure from the wording.

A code keeps the user in the tab they signed up in, works when the mail is read
on another device, and cannot be consumed by a mail scanner that follows links.
It is weaker per guess than a long token, so it is bounded: 10 minutes, three
wrong guesses before it is discarded, a per-client rate limit on the route, and
only its hash stored, the same treatment as share links (ADR-0011). The code is
kept out of the subject line, where lock screens would show it.

Better Auth's email OTP plugin supplies the code, and it also brings sign-in by
code, password reset by code and email change by code. Those routes are closed.
Signing in with a code would skip both the password and the TOTP second factor,
and resets stay on the link flow. Confirming an address does not create a
session either: the user signs in with their password afterwards, as before.
Signing in to an unconfirmed account sends a fresh code, so a lost first email
does not strand the account.

Rejected: keeping the link alongside the code. Two live credentials for one
address double what a stolen mailbox yields and make the email harder to read,
for no case the code does not already cover.
