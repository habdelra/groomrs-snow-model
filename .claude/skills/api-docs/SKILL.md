---
name: api-docs
description: Keeping the client-facing API documentation in docs/api/ accurate — which code each document describes, what counts as a client-visible change, and how to check examples against the running stack. Use whenever a change touches src/api/routes.ts, src/contract/v1.ts, job statuses or blocked/failed reasons, request defaults or limits, error codes, resort fields returned by the API, or anything else a caller of the HTTP API can observe.
---

# API documentation

`docs/api/` is the reference for clients of the HTTP API, mainly Boxel's pipeline. Clients learn the API from these documents, not from the code, so a client-visible change isn't finished until they match it. **Update the docs in the same PR as the change.**

## What each document covers

| Document                      | Describes                                                                                                               | Source of truth                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `docs/README.md`              | Index of the documents.                                                                                                 | –                                                                                         |
| `docs/api/overview.md`        | Base URL, auth, units, times, seasons, model points, `configVersion`, versioning, the end-to-end workflow, attribution. | `src/season.ts`, `src/resorts/registry.ts` (`modelPoints`), `src/contract/v1.ts`          |
| `docs/api/endpoints.md`       | Every route: parameters, bodies, defaults, limits, status codes, examples.                                              | `src/api/routes.ts`, `src/contract/v1.ts` (request schemas)                               |
| `docs/api/jobs.md`            | Job lifecycle, polling, idempotency, `blocked`/`failed` reasons, lineages.                                              | `src/jobs/queue.ts`, `src/jobs/worker.ts`, `src/jobs/model.ts`, every `new BlockedError(` |
| `docs/api/result-document.md` | Every field of the result document, its unit and meaning; profile sampling; data gaps.                                  | `src/contract/v1.ts` (`ResultDocument`), `src/snowpack/parse.ts`, `src/jobs/model.ts`     |
| `docs/api/errors.md`          | The error body and every `error` code, including Fastify's own error bodies.                                            | `problem(...)` calls in `src/api/routes.ts`                                               |

## Changes that need a docs update

- A route added, removed or changed, including query parameters, defaults (`horizonHours`, the weather window) and limits (`MAX_WEATHER_WINDOW_HOURS`, `max(168)`).
- A field added to the contract, or any change to a field's meaning. Every field in `src/contract/v1.ts` has a row in `result-document.md` or `endpoints.md` with its unit. Renames, removals and unit changes also need a v2 (see `AGENTS.md`), and the versioning section of `overview.md` should then explain both versions.
- A new `BlockedError` reason or failed reason. Add it to the tables in `jobs.md`, with its cause and what the client should do.
- A new `problem(reply, status, 'code', …)` code, or a changed status. Update `errors.md` and the endpoint's error table.
- Job semantics: idempotency matching, attempts, ordering, lease behaviour, how refresh picks its checkpoint.
- Sampling and shape: `PROFILE_INTERVAL_HOURS`, inclusive window ends, point order, the point-count thresholds.
- Resort fields in `resortView`. A new resort YAML on its own doesn't need a docs change, since the docs only use Vail as an example.

## Keep the examples real

Example responses in the docs come from the running stack, not from memory. After changing behaviour:

```sh
mise run stack:up                                   # rebuild: the container runs a copy of src/
curl -s localhost:8090/v1/resorts/vail-co
curl -s 'localhost:8090/v1/resorts/vail-co/results/latest?profileDepthCm=5' | jq '.points[0] | {state, files, met0: .met[0], prof0: .profiles[0]}'
curl -s -XPOST localhost:8090/v1/resorts/vail-co/refresh -H 'content-type: application/json' -d '{}'   # error shapes
```

Check claims about edge cases the same way, by sending the request, before writing them down. Several looked obvious and were wrong when tested: `text/plain` bodies reach the API's validator instead of returning `415`, and asOf offsets like `+02:00` are rejected.

Snip long arrays in examples with `"…"` rather than inventing values. Keep the example ids consistent across documents (the Vail 2026-02-03 refresh: job `05557bb1-…`, result `69a02752-…`, lineage `9465f067-…`) so a reader can follow one run through.

## Style

- Metric only, matching the API. Never add imperial conversions to the docs.
- The docs describe the API from a client's point of view. Don't document internals (tables, file layout under `DATA_DIR`, mise tasks) beyond what a client needs. Those belong in `README.md` and the other skills.
- `mise run lint` runs Prettier over Markdown, so run `mise run lint:fix` after editing.
