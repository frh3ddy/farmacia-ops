# Remove Stale Docs Epic

**Status**: ✅ COMPLETED (2026-10-31)
**Goal**: No hand-written doc in the repo describes the system differently from how it works

## Overview

`docs/` holds four hand-written files, three untouched since 2026-01-30 and one since 2026-08-29. Each was written before or during the work it describes, and the code has moved on since (for example, `SessionGuard` is gone). CLAUDE.md says to keep no hand-maintained architecture docs: the graphify graph and `prisma/schema.prisma` are the map. Nothing links to these files.

---

## Delete the Stale Docs

Delete `docs/AUTHENTICATION.md`, `docs/DATA_MODELS.md`, `docs/testing-inventory-consumption.md` and `docs/yastas-integration-plan.md`.

**Requirements**:
- Given the repo after the change, should have no `docs/` folder
- Given README, CLAUDE.md, AGENTS.md and vision.md, should hold no link to a deleted file
- Given the graphify graph, should be regenerated without the deleted files

---
