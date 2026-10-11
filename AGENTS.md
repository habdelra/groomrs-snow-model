# Instructions for AI agents

This repo is the GROOMRS snow-model service: self-hosted Open-Meteo weather → SNOWPACK/MeteoIO → raw, metric snowpack data over HTTP for Boxel's scheduling pipeline. Read `README.md` first for what it does and how to run it.

## Boundaries (hard rules)

- **Raw data only.** Never add interpretation: no carving scores, condition labels, confidence or best windows. Those live in Boxel's deterministic rules and AI analysis. If a derived quantity seems useful, return the physical inputs it needs instead.
- **Metric only.** The API, the database, resort configs and logs are metric. Temperatures are °C, depths cm, water mm, density kg/m³, wind m/s, radiation W/m². Every numeric contract field names its unit (`snowDepthCm`). Never add °F, inches or feet; Boxel converts for display. SNOWPACK/SMET files keep their native SI units (K, m, fractions). All conversions go through `src/units.ts`.
- **Never write to Boxel.** The service answers requests; the Boxel pipeline publishes.
- **Contract versioning.** `src/contract/v1.ts` is the Boxel-facing contract. Adding a field is fine. Renaming or removing a field, or changing its unit or meaning, needs a v2.

## Toolchain

- Run everything through mise tasks (`mise tasks` lists them; scripts live in `mise-tasks/`). `package.json` has no scripts.
- TypeScript runs natively on Node 24 (type stripping). There is no build and no `dist/`. Don't add tsx, ts-node, a bundler or Vitest.
  - `erasableSyntaxOnly`: no `enum`, `namespace` or constructor parameter properties. Use `as const` objects and union types.
  - `verbatimModuleSyntax`: write `import type` for types. Relative imports carry the `.ts` extension.
- `mise run typecheck` runs `tsc --noEmit`, the only type check. `mise run lint` runs ESLint and Prettier (`mise run lint:fix` fixes).
- Tests use `node:test` + `node:assert/strict`.

## Running and testing

- `mise run stack:up` starts Postgres (127.0.0.1:5436), Open-Meteo (:8080) and the service (:8090).
- `mise run test` runs the unit tests. `mise run test:integration` runs against the running stack with real Open-Meteo data and real SNOWPACK runs; rebuild with `mise run stack:up` after changing `src/`, because the container runs a copy.
- Capture long test output to a file and grep it, rather than piping through `tail`.
- The `snow-model-testing` skill covers fixtures, hindcast dates and CI.

## Database

- Postgres, migrated with node-pg-migrate. Load the `db-migrations` skill before creating or changing a migration.
- Connection settings come only from `DATABASE_URL` or the `PG*` variables. Never assume the DB is the Compose container; it is meant to move to RDS.
- Model data (weather responses, SMET, `.sno`/`.pro`/`.met`) stays in files under `DATA_DIR`. The database holds metadata and, later, observations.

## Skills

Project skills are in `.claude/skills/`. Load the matching one before working in its area:

| Skill                  | When                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `snowpack-runtime`     | Changing the ini template, SMET forcing, output parsing, checkpoints, or running SNOWPACK by hand |
| `open-meteo-self-host` | Weather fetching, the cache, model choice, or Open-Meteo container issues                         |
| `db-migrations`        | Any schema change                                                                                 |
| `snow-model-testing`   | Writing or debugging tests, fixtures or CI                                                        |
| `add-a-resort`         | Adding or changing a resort config                                                                |

**Keep the skills current.** When you learn something non-obvious here (a SNOWPACK quirk, an Open-Meteo coverage gap, a failure mode and its fix), add it to the relevant skill, or create a new skill, in the same change. Skills are how the next agent avoids relearning it.
