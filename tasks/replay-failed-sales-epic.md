# Replay Failed Sales Epic

**Status**: ✅ COMPLETED (2026-11-01)
**Goal**: The owner can see the Square sales the worker gave up on and send them back to be recorded, without touching Redis

## Overview

A Square sale or refund the worker can't record fails its job, and failed sale jobs are kept 30 days for replay. Sales are now refused at a store that hasn't finished its cutover, so on go-live night a store whose migration fails builds up failed sales that need replaying once it's cut over. Nothing in the app could replay them: the nightly check only reports them, so a replay meant `job.retry()` by hand in Redis. Separately, the api's test Postgres picked a random port from a fixed range of 1,000, so parallel suites sometimes collided (`EADDRINUSE`) and failed at random.

---

## Replay Failed Sales

List the failed Square sales and refunds for the owner, and replay them all in one action.

**Requirements**:
- Given failed sale, refund, return and match jobs, should replay only the sales and refunds, each with a fresh set of attempts
- Given a failed sale, should list its Square payment (or refund) id and why it failed, never the rest of the job data
- Given someone who isn't an owner, should refuse both the list and the replay
- Given failed sales, should show the owner how many on the integrity banner, with their reasons in the details and a button to replay them
- Given a replay that went through, should say how many sales went back to be recorded
- Given a replay that didn't go through, should say so and keep the button

---

## Test Postgres on a Free Port

**Requirements**:
- Given test suites starting Postgres in parallel, should give each a port the OS reports free
