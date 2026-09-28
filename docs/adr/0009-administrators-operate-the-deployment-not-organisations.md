# Administrators operate the deployment, not the organisations in it

SRS 2.3 describes `ADMIN` as an operator of the WVS deployment itself. An
administrator therefore acts across every organisation on administrative data:
accounts, quotas, the network blocklist, the kill switch, the audit log and
system health. An administrator gains no access to any other organisation's
targets, scans, findings or evidence. Inside their own organisation they act as
any other writer does.

The alternative, an administrator who can read everything, would put every
customer's scan evidence behind one role. C.7 limits personal data to what
authentication and audit require, and a role that reads everything is also the
most valuable account in the system to steal. Administrators scoped to one
organisation were rejected because the kill switch and the blocklist are
deployment-wide by nature.

## Consequences

Because the role reaches every organisation, two safeguards come with it:

- Every administrative endpoint requires the caller to have two-factor
  authentication enabled.
- The role is never granted at signup. The first administrator is created by a
  command-line script run on the deployment host, which writes an audit record.
  Later ones are granted in the admin UI. Granting by an environment variable
  was rejected because it hands the role to whoever registers a listed address
  first. Granting it to the first user to sign up was rejected because that is a
  race on any deployment the public can reach.
