# groomrs-snow-model

The GROOMRS snow-model service. For each configured ski resort it pulls hourly weather from a self-hosted [Open-Meteo](https://open-meteo.com/), runs the SLF [SNOWPACK](https://snowpack.slf.ch/) model (with MeteoIO) at the resort's base/mid/summit points, keeps each point's seasonal snowpack state, and serves the raw results over HTTP.

It is the "separate snow-model service" in the GROOMRS system architecture (`groomrs-design/groomrs-system-architecture.md`). Boxel's scheduling pipeline calls it, normalizes the result and publishes cards.

**What it does not do:**

- **No interpretation.** It returns physical quantities: weather forcing, snow depth, layer densities, grain types, temperatures and so on. Carving quality, condition labels and confidence belong to Boxel's deterministic rules and AI analysis.
- **No imperial units.** Everything is metric (see [Units](#units)). Boxel converts for display.
- **No publishing.** It never writes to Boxel. The pipeline is the publication boundary.

## Stage 1 scope

- Runs locally under Docker Compose, with no authentication.
- Natural snow only: no snowmaking scenarios or grooming yet. The contract already carries `scenario: "natural"` so scenarios can be added later.
- Seed resorts: Blue Mountain (PA), Vail (CO) and El Colorado (Chile).

## Prerequisites

- [mise](https://mise.jdx.dev/), which pins Node 24 and pnpm (`.mise.toml`).
- Docker with Compose v2. Open-Meteo wants roughly 8 GB of RAM and an x86-64 CPU with AVX2.

```sh
mise trust && mise install
pnpm install
```

## Quick start

```sh
mise run stack:up                      # Postgres + Open-Meteo + snow-model, waits until healthy
curl -s localhost:8090/health
curl -s localhost:8090/v1/resorts
```

Spin up last winter at Vail and get a 48-hour result:

```sh
curl -s -XPOST localhost:8090/v1/resorts/vail-co/seasons/2025-26/initialize \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"vail-2025-26","asOf":"2026-02-01T12:00:00Z","spinupDays":30}'
# → {"jobId":"…"}; poll until status is "complete"
curl -s localhost:8090/v1/jobs/<jobId>

curl -s -XPOST localhost:8090/v1/resorts/vail-co/refresh \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"vail-2026-02-03","asOf":"2026-02-03T06:00:00Z","horizonHours":48}'
curl -s localhost:8090/v1/jobs/<jobId>                       # → resultId
curl -s 'localhost:8090/v1/results/<resultId>?profileDepthCm=20'
```

## Tasks

Run everything through mise. It activates the pinned toolchain and the host-side environment (`PG*`, `OPEN_METEO_URL`, `SNOW_MODEL_URL`, `DATA_DIR`). Task scripts live in `mise-tasks/`; `mise tasks` lists them.

| Task                                                      | What it does                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mise run stack:up`                                       | Build and start the Compose stack, waiting until every service is healthy.                                                                                                                                                                                       |
| `mise run stack:down`                                     | Stop it. `mise run stack:down -- -v` also deletes the volumes (database, model data, Open-Meteo cache).                                                                                                                                                          |
| `mise run stack:logs [service]`                           | Follow logs from `snow-model`, `open-meteo` or `postgres`.                                                                                                                                                                                                       |
| `mise run dev`                                            | Run the service on the host with `node --watch`, against the Compose Postgres and Open-Meteo. Stops the containerized service so port 8090 is free. Without a local `snowpack` binary it runs SNOWPACK from the service image (`scripts/snowpack-in-docker.sh`). |
| `mise run start`                                          | Run the service on the host without watching.                                                                                                                                                                                                                    |
| `mise run migrate`                                        | Create the database if it's missing, then apply migrations. Also `migrate down [n]`, `migrate create <name>`, `migrate create-removal <name>`.                                                                                                                   |
| `mise run probe:open-meteo [resortId…] [-- --models a,b]` | Report variable completeness, history reach and forecast reach per point and model.                                                                                                                                                                              |
| `mise run typecheck`                                      | `tsc --noEmit`.                                                                                                                                                                                                                                                  |
| `mise run lint` / `mise run lint:fix`                     | ESLint and Prettier.                                                                                                                                                                                                                                             |
| `mise run test`                                           | Unit tests. No services needed.                                                                                                                                                                                                                                  |
| `mise run test:integration`                               | Integration tests against the running stack.                                                                                                                                                                                                                     |
| `mise run test:all`                                       | Both.                                                                                                                                                                                                                                                            |

There is no build step. Node 24 runs the TypeScript directly (type stripping), so `node src/server.ts` is the entry point both on the host and in the container.

## Configuration

| Variable                            | Default                 |                                                                                                                          |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`                      | –                       | Postgres connection string. When unset, node-postgres reads `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE`. |
| `PGSSLMODE`                         | –                       | Set to `require` for a managed Postgres such as RDS.                                                                     |
| `AUTO_MIGRATE`                      | `true`                  | Create the database if missing and run migrations on startup.                                                            |
| `OPEN_METEO_URL`                    | `http://127.0.0.1:8080` | Base URL of the Open-Meteo API (self-hosted or hosted).                                                                  |
| `DATA_DIR`                          | `./data`                | Root for weather cache, run directories, checkpoints and results.                                                        |
| `PORT` / `HOST`                     | `8090` / `127.0.0.1`    | Listen address (`0.0.0.0` in the container).                                                                             |
| `SNOWPACK_BIN`                      | `snowpack`              | SNOWPACK executable.                                                                                                     |
| `SNOWPACK_TIMEOUT_MS`               | `900000`                | Per-run timeout.                                                                                                         |
| `WORKER_ENABLED` / `WORKER_POLL_MS` | `true` / `1000`         | In-process job worker.                                                                                                   |
| `OPEN_METEO_CACHE_SIZE`             | `4GB`                   | Compose only: Open-Meteo's on-disk cache, preallocated at full size.                                                     |

## API (v1)

All numbers are metric, and every numeric field names its unit (`airTempC`, `snowDepthCm`, `densityKgM3`). Times are ISO-8601 UTC. `GET /v1/schema` returns the JSON Schema of the requests and the result document.

| Endpoint                                                    |                                                                                                                                                                                    |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                               | SNOWPACK version, Open-Meteo reachability, database and migration head.                                                                                                            |
| `GET /v1/resorts`, `GET /v1/resorts/:id`                    | Resort config, model points and `configVersion`.                                                                                                                                   |
| `GET /v1/resorts/:id/weather?point=&start=&end=`            | Normalized hourly weather for one point, at most 31 days.                                                                                                                          |
| `POST /v1/resorts/:id/seasons/:season/initialize`           | Seasonal spin-up through the start of `asOf`'s UTC day. Season ids look like `2025-26` (north) or `2026` (south). Body: `{ idempotencyKey, asOf?, spinupDays? }`.                  |
| `POST /v1/resorts/:id/refresh`                              | Advance the saved state to the start of `asOf`'s UTC day with past weather, then run `horizonHours` (≤ 168) forward from a copy. Body: `{ idempotencyKey, asOf?, horizonHours? }`. |
| `GET /v1/jobs/:id`                                          | `queued`, `running`, `blocked`, `complete` or `failed`, plus per-point progress, the error and `resultId`.                                                                         |
| `GET /v1/results/:id`, `GET /v1/resorts/:id/results/latest` | The result document. `?profileDepthCm=N` keeps only layers within N cm of the surface.                                                                                             |
| `GET /v1/runs/:runId/files/<path>`                          | Native files from a run: `io.ini`, `input/*.smet`, `output/*.pro` and so on.                                                                                                       |

Jobs are idempotent: reposting the same body with the same `idempotencyKey` returns the existing job, and reusing a key for a different body is a `409`. A job is `blocked` when it can't proceed until something changes: `not_initialized`, `before_spinup` or `weather_coverage`.

A result document holds, for each point:

- `state`: the checkpoint the forecast started from, and its lineage;
- `forcing`: hourly weather;
- `met`: SNOWPACK's hourly series, such as snow depth, SWE, surface temperature, energy fluxes, new snow and skier penetration;
- `profiles`: layer stacks every 3 h, surface first, with density, temperature, liquid water, grain size, bond size, grain type and hand hardness.

It also carries provenance (weather model and retrieval time, whether the weather was archived or forecast, SNOWPACK and service versions) and any data gaps.

### Units

SNOWPACK and SMET files on disk keep SNOWPACK's native SI units (K, m, fractions). Everything else is metric: °C, cm for depths and heights, mm for water, kg/m³, m/s, W/m² and %. All conversions live in `src/units.ts`.

## How it works

```text
Open-Meteo (self-hosted, reads Open-Meteo's public S3 bucket)
  └─ hourly weather per point (elevation-downscaled), cached by month under DATA_DIR/weather
       └─ SMET forcing (TA K, RH 0–1, VW, DW, ISWR, PSUM, PSUM_PH, CLD oktas)
            └─ SNOWPACK + MeteoIO (ILWR from AllSkyLW, phase fallback PRECSPLITTING)
                 ├─ past weather → saved state (.sno checkpoint), one lineage per spin-up
                 └─ forecast → run from a copy of the state, never saved
                      └─ parse .smet/.pro → result document (metric)
```

- **Model points** follow vertical drop: 1 point under 300 m, base and summit under 800 m, otherwise base, mid and summit.
- **Seasons**: a northern season spans the new year (`2025/26`), a southern one is a calendar year. Spin-up starts `spinupDays` (default 75) before the typical opening, from bare ground.
- **Jobs** live in Postgres and run one at a time in an in-process worker. A running job holds a lease. If the process dies, the lease lapses and the job is claimed again, resuming from the checkpoints it already saved.

## Data layout

Files under `DATA_DIR`, in the tools' native formats:

```text
weather/open-meteo/<model>/<resort>/<point>/<YYYY-MM>.<hash>.json   raw responses (archived months never refetched)
runs/<runId>/io.ini, input/<POINT>.smet, input/<POINT>.sno,         one SNOWPACK execution
            output/<POINT>_run.{smet,pro,sno,haz}, snowpack.*.log, weather-sources.json
states/<resort>/<point>/<season>/<validTime>.<runId>.sno            checkpoints
results/<resultId>.json                                             result documents
```

Postgres tables (`migrations/`):

| Table               | Holds                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| `jobs`              | One row per requested job, with its idempotency key, status, lease and error. |
| `model_runs`        | One SNOWPACK execution: point, kind, window, versions and run directory.      |
| `state_checkpoints` | Saved state per point and valid time, with its lineage.                       |
| `results`           | Result documents.                                                             |

Grooming reports and base-depth observations will get their own tables here.

## Adding a resort

Add `config/resorts/<id>.yaml` (elevations in metres; cite your sources), run `mise run probe:open-meteo <id>` to pick a weather model, then initialize a season. `.claude/skills/add-a-resort` has the details.

## Tests

- **Unit** (`test/unit`, `node:test`): unit conversions, season maths, the resort registry, the SMET writer, and parsers checked against real SNOWPACK output fixtures.
- **Integration** (`test/integration`): runs against the live stack with real data. It covers:
  - health checks;
  - weather for every point of every resort;
  - full hindcasts for Blue Mountain and Vail (spin-up, advance, forecast, file download, profile trimming);
  - idempotency and blocked jobs;
  - El Colorado's current season through a live forecast.

CI (`.github/workflows/ci.yml`) runs the type check, lint and unit tests in one job, and the integration suite against the Compose stack in another.

## Licences and attribution

- Weather data: [Open-Meteo](https://open-meteo.com/), CC BY 4.0. Attribution is required wherever the data is shown. The Open-Meteo server is AGPL-3.0 and runs unmodified in its own container.
- [SNOWPACK](https://snowpack.slf.ch/) and MeteoIO by WSL Institute for Snow and Avalanche Research SLF, LGPL-3.0. They are installed from SLF's release `.deb` (version pinned in the `Dockerfile`).
