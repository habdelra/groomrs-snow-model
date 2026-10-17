---
name: snow-model-testing
description: How groomrs-snow-model is tested — node:test unit tests on native TypeScript, real-SNOWPACK fixtures, the integration suite that runs against the live Compose stack with real Open-Meteo data, how to pick hindcast dates and idempotency keys so reruns stay deterministic, and how CI runs it. Use when adding or changing tests, regenerating fixtures, debugging a failing integration test, or editing .github/workflows/ci.yml.
---

# Testing

Both tiers use `node:test` + `node:assert/strict` on `.ts` files run natively by Node 24. Don't add Vitest or Jest: they transpile, which the no-build setup avoids.

| Tier                             | Command                     | Needs               |
| -------------------------------- | --------------------------- | ------------------- |
| Unit (`test/unit`)               | `mise run test`             | nothing             |
| Integration (`test/integration`) | `mise run test:integration` | `mise run stack:up` |
| Both                             | `mise run test:all`         | the stack           |

Run one file with `node --test test/unit/parse.test.ts`, or filter by name with `mise run test -- --test-name-pattern "phase"`.

**Rebuild before integration runs.** The service under test is the container, which holds a copy of `src/`, so run `mise run stack:up` (it builds) after any `src/` change. A stale image produced a phantom failure once: `profileDepthCm` "didn't work" because the container predated it.

Capture runs to a file (`mise run test:integration > /tmp/it.log 2>&1`) and grep for `✖` / `not ok`. Don't pipe through `tail` and lose the details.

## Unit fixtures

`test/fixtures/vail-base-run.{smet,pro,sno}` are real SNOWPACK 3.7.0 outputs from Vail base, a forecast from 2026-02-01, truncated to 25 hours and 2 profiles. They were produced by the service, not written by hand. To regenerate:

1. Run a refresh.
2. `docker compose cp snow-model:/data/runs/<runId>/output/BASE_run.smet test/fixtures/...`.
3. Truncate it, and update the exact-value assertions in `test/unit/parse.test.ts`.

The Open-Meteo client is tested against an injected `fetchImpl` stand-in that answers any date range. Use the client's `now` option to test cache TTL and archive behaviour.

## Integration tests: rules that keep them deterministic

- **Hindcast dates sit in last winter**, where archived weather no longer changes: Blue Mountain and Vail use `asOf 2026-02-01` (initialize, `spinupDays: 30`) and `2026-02-03` (refresh, 48 h).
  - Both resorts have snow then (Blue Mountain summit about 32 cm, Vail summit about 63 cm), so "summit has snow" is a safe assertion.
  - When moving dates to a newer winter, check the ECMWF coverage first (`open-meteo-self-host`).
- **Idempotency keys include `RUN_NONCE`** (`test/helpers/api.ts`), so reruns against the same database create fresh jobs and a fresh lineage. The refresh test then sees its own lineage and must run `advance` + `forecast` per point. Before lineages existed, a rerun reused a 3 Feb checkpoint left by an earlier run and skipped `advance`.
- **"Current season" uses El Colorado**: its season is the calendar year, so `now` always falls inside one. It asserts completeness, not snow (the snowpack can be gone late in the year).
- Tests read Postgres directly through `dbQuery` (PG* from `.mise.toml`) to check what was recorded, such as no new `model_runs` on an idempotent retry.
- Integration files run serially (`--test-concurrency=1`). The service also runs jobs one at a time.
- The integration tests and `docs/api/` describe the same behaviour. When a test pins down something new a client can observe (a status code, an error reason, a series length), check the docs say the same (see the `api-docs` skill).

## Timing

- Warm caches: about 70 s for the integration suite, most of it El Colorado's 6-month spin-up.
- After `stack:down -v` (cold weather cache and Open-Meteo cache): several minutes.

## CI (.github/workflows/ci.yml)

- `check`: `jdx/mise-action`, `pnpm install --frozen-lockfile`, then `mise run typecheck`, `lint` and `test`.
- `integration`: `mise run stack:up` with `OPEN_METEO_CACHE_SIZE=2GB`, then `mise run test:integration`. On failure it uploads `docker compose logs` as the `compose-logs` artifact.
- CI pulls real data from Open-Meteo's public S3 bucket every run. There's nothing to cache usefully: the Open-Meteo cache file is preallocated and service data is per-run.
