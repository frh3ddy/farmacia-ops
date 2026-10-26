# Custom Agent Instructions

Add project-specific agent instructions here. Settings in this file override the root AGENTS.md.

## Precedence

`CLAUDE.md` (project, `~/dev/CLAUDE.md`, `~/CLAUDE.md`) wins over any AIDD skill or command
when they disagree. In particular:

- Branch per change (`feature/…`, `fix/…`, `chore/…`); never develop on `main`.
- Commit or push only when the user asks. A `feat:`/`fix:` commit is paired with a
  separate `test:` commit (CI's check-test-pairing enforces it for `feat:`).
- `npm test` must pass before pushing; run `graphify update .` after code changes.
- FIFO consumption is ordered by `receivedAt ASC`, never `createdAt`.
- Secret comparison uses `crypto.timingSafeEqual` (see `apps/api/src/auth/password.ts`);
  the unlinked `aidd-timing-safe-compare` skill's SHA3 rule does not apply here.
- Stack is NestJS + React 19 (Vite) + Prisma — not Next.js/Redux/shadcn; skip stack
  advice that assumes those.
