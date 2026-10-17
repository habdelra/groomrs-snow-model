# API overview

The snow-model service models the natural snowpack at a ski resort's base, mid and summit points. It pulls hourly weather from Open-Meteo, runs the SLF SNOWPACK model, and returns **raw physical quantities**: weather forcing, snow depth, snow water equivalent, energy fluxes and layer-by-layer snow profiles.

It does not interpret them. There are no condition labels, carving scores or confidence values in any response; deriving those is the client's job.

## Base URL and authentication

| Environment            | Base URL                |
| ---------------------- | ----------------------- |
| Local (Docker Compose) | `http://127.0.0.1:8090` |

Stage 1 has **no authentication**. The Compose stack binds the port to `127.0.0.1` only.

All request and response bodies are JSON (`application/json`), except the [native run files](endpoints.md#get-v1runsrunidfilespath), which are plain text. Send `content-type: application/json` with every `POST` body.

## Conventions

### Units

Everything is metric, and **every numeric field names its unit in its name**:

| Suffix     | Unit                      | Example                    |
| ---------- | ------------------------- | -------------------------- |
| `C`        | degrees Celsius           | `airTempC`                 |
| `Cm`       | centimetres               | `snowDepthCm`              |
| `Mm`       | millimetres (water)       | `sweMm`, `precipitationMm` |
| `M`        | metres                    | `elevationM`               |
| `Ms`       | metres per second         | `windSpeedMs`              |
| `Wm2`      | watts per square metre    | `sensibleHeatWm2`          |
| `KgM3`     | kilograms per cubic metre | `densityKgM3`              |
| `Pct`      | percent (0–100)           | `relativeHumidityPct`      |
| `Fraction` | fraction (0–1)            | `albedoFraction`           |
| `Deg`      | degrees from north        | `windDirectionDeg`         |
| `Hpa`      | hectopascals              | `surfacePressureHpa`       |
| `MmPerH`   | millimetres per hour      | `snowfallRateMmPerH`       |
| `MjM2`     | megajoules per m²         | `coldContentMjM2`          |

There are no imperial units anywhere. Convert on the client for display.

Most measured values are **nullable**. `null` means the value was missing from the source (Open-Meteo or SNOWPACK output); the service never invents or interpolates a value.

### Times

- All times are ISO-8601 in UTC, and responses always use the form `2026-02-03T00:00:00.000Z`.
- Request times (`asOf`, `start`, `end`) must be UTC with a `Z` suffix. An offset such as `+02:00` is rejected with `400`.
- Hourly series are keyed by the **start** of the hour.
- Model runs work in whole UTC days: an `asOf` of `2026-02-03T06:00:00Z` means "state at `2026-02-03T00:00:00Z`".

### Resorts and model points

A resort is identified by a slug such as `vail-co`. [`GET /v1/resorts`](endpoints.md#get-v1resorts) lists them. Each resort is modelled at one to three **points**, chosen from its vertical drop:

| Vertical drop | Points                  |
| ------------- | ----------------------- |
| < 300 m       | `mid`                   |
| 300–799 m     | `base`, `summit`        |
| ≥ 800 m       | `base`, `mid`, `summit` |

Each point is an independent, flat, open-field snow column at the given elevation. Use the `points` array from the resort endpoint rather than assuming all three exist.

Every resort also has a `configVersion`, a 12-character hash of its configuration and the SNOWPACK settings. It changes whenever anything that affects the model output changes. Result documents record the `configVersion` that produced them. When it changes, the season has to be [initialized](endpoints.md#post-v1resortsidseasonsseasoninitialize) again before refreshes work.

### Seasons

The model keeps snowpack state per season, so seasons are part of the API:

| Hemisphere | Season runs             | Season id in a URL | Season id in a response |
| ---------- | ----------------------- | ------------------ | ----------------------- |
| `north`    | 1 July – 30 June        | `2025-26`          | `2025/26`               |
| `south`    | 1 January – 31 December | `2026`             | `2026`                  |

Note the different separator: URLs use a hyphen (`2025-26`), while response bodies use a slash (`2025/26`).

### Versioning

Paths are prefixed `/v1`, and result documents carry `"schemaVersion": "groomrs-snow-model/v1"`. Within v1, fields may be **added** but are never renamed, removed or changed in unit or meaning; any such change ships as v2. Clients should ignore fields they don't recognise.

## How the model works, from a client's point of view

The model has to build up a season's snowpack from bare ground before it can say anything about today. This happens in two job types:

1. **Initialize** (once per season, per configuration). A "spin-up" runs SNOWPACK from bare ground, starting `spinupDays` before the resort's typical opening day, through to the day you name. It saves the resulting snowpack state for each point as a checkpoint. This can take minutes.
2. **Refresh** (as often as you like). First the saved state is advanced to the start of `asOf`'s UTC day using observed (archived) weather, and that becomes the new checkpoint. Then the model runs forward `horizonHours` from a **copy** of that state using forecast weather. The forecast never touches the saved state, so forecast error doesn't accumulate. A refresh produces a [result document](result-document.md).

Both are **asynchronous jobs**: you `POST` to create one, then poll `GET /v1/jobs/:id` until it finishes. See [Jobs](jobs.md).

## End-to-end example

```sh
BASE=http://127.0.0.1:8090

# 1. Find the resort and its model points.
curl -s $BASE/v1/resorts/vail-co

# 2. Initialize the 2025/26 season through 1 Feb 2026.
curl -s -XPOST $BASE/v1/resorts/vail-co/seasons/2025-26/initialize \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"vail-2025-26-init","asOf":"2026-02-01T12:00:00Z","spinupDays":30}'
# → 202 {"jobId":"9465f067-…","created":true,"job":{…,"status":"queued"}}

# 3. Poll until the job leaves "queued"/"running".
curl -s $BASE/v1/jobs/9465f067-…
# → {"status":"complete","resultId":null,…}   (initialize jobs produce no result)

# 4. Refresh: advance to 3 Feb and run 48 hours forward.
curl -s -XPOST $BASE/v1/resorts/vail-co/refresh \
  -H 'content-type: application/json' \
  -d '{"idempotencyKey":"vail-2026-02-03","asOf":"2026-02-03T06:00:00Z","horizonHours":48}'
# → 202 {"jobId":"05557bb1-…",…}

# 5. Poll the refresh job; when complete it carries a resultId.
curl -s $BASE/v1/jobs/05557bb1-…
# → {"status":"complete","resultId":"69a02752-…",…}

# 6. Fetch the result, keeping only the top 20 cm of each snow profile.
curl -s "$BASE/v1/results/69a02752-…?profileDepthCm=20"
```

A daily pipeline normally initializes each season once, then calls refresh once per run with an idempotency key derived from the resort and date (for example `vail-co/2026-02-03`), so retries never duplicate work.

## Data attribution

Weather data comes from [Open-Meteo](https://open-meteo.com/) under CC BY 4.0. **Attribution is required wherever the data is shown**, including values derived from it. Snow modelling uses [SNOWPACK](https://snowpack.slf.ch/) by the WSL Institute for Snow and Avalanche Research SLF.
