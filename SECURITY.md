# Security Policy

This is private internal tooling for a single pharmacy operation. It is not a
public project and has no bug-bounty program.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository owner (see `git log`
for the maintainer) — do not open a public issue or PR describing the exploit.

Include: affected component, reproduction steps, and impact. Expect an
acknowledgement within a few business days.

## Handling secrets

- Never commit `.env`, API tokens, Square credentials, or database URLs. These
  are gitignored; keep them that way.
- Rotate any credential that lands in git history.
