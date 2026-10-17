# Endpoints

All paths are relative to the [base URL](overview.md#base-url-and-authentication). Error responses use the [standard error body](errors.md).

| Method | Path                                                                                     | Purpose                                       |
| ------ | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| `GET`  | [`/health`](#get-health)                                                                 | Readiness of the service and its dependencies |
| `GET`  | [`/health/live`](#get-healthlive)                                                        | Liveness probe                                |
| `GET`  | [`/v1/schema`](#get-v1schema)                                                            | JSON Schema of the v1 contract                |
| `GET`  | [`/v1/resorts`](#get-v1resorts)                                                          | All configured resorts                        |
| `GET`  | [`/v1/resorts/:id`](#get-v1resortsid)                                                    | One resort                                    |
| `GET`  | [`/v1/resorts/:id/weather`](#get-v1resortsidweather)                                     | Hourly weather for one point (synchronous)    |
| `POST` | [`/v1/resorts/:id/seasons/:season/initialize`](#post-v1resortsidseasonsseasoninitialize) | Start a seasonal spin-up job                  |
| `POST` | [`/v1/resorts/:id/refresh`](#post-v1resortsidrefresh)                                    | Start a refresh (advance + forecast) job      |
| `GET`  | [`/v1/jobs/:id`](#get-v1jobsid)                                                          | Job status                                    |
| `GET`  | [`/v1/results/:id`](#get-v1resultsid)                                                    | A result document                             |
| `GET`  | [`/v1/resorts/:id/results/latest`](#get-v1resortsidresultslatest)                        | The newest result document for a resort       |
| `GET`  | [`/v1/runs/:runId/files/*path`](#get-v1runsrunidfilespath)                               | A native SNOWPACK file from a run             |

---

## `GET /health`

Reports whether the service can do work: SNOWPACK is installed, Open-Meteo answers, and the database is reachable.

**Responses**

- `200` when everything is healthy (`ok: true`).
- `503` with the same body when anything is not (`ok: false`).

```json
{
  "ok": true,
  "schemaVersion": "groomrs-snow-model/v1",
  "serviceVersion": "0.1.0",
  "snowpackVersion": "3.7.0",
  "openMeteo": { "reachable": true, "url": "http://open-meteo:8080" },
  "database": {
    "reachable": true,
    "migrationHead": "1791734141239_initial-jobs-and-runs"
  }
}
```

| Field                    | Type           | Description                                              |
| ------------------------ | -------------- | -------------------------------------------------------- |
| `ok`                     | boolean        | `true` only when all three dependencies are available.   |
| `schemaVersion`          | string         | Contract version, `groomrs-snow-model/v1`.               |
| `serviceVersion`         | string         | Version of this service.                                 |
| `snowpackVersion`        | string \| null | Installed SNOWPACK version; `null` if it can't be run.   |
| `openMeteo.reachable`    | boolean        | Whether a test forecast request to Open-Meteo succeeded. |
| `openMeteo.url`          | string         | The Open-Meteo base URL the service uses.                |
| `database.reachable`     | boolean        | Whether Postgres answered.                               |
| `database.migrationHead` | string \| null | Latest applied migration.                                |

## `GET /health/live`

Liveness only: answers as long as the process is up, without checking dependencies.

**Response** `200`

```json
{ "ok": true }
```

| Field | Type    | Description                                                 |
| ----- | ------- | ----------------------------------------------------------- |
| `ok`  | boolean | Always `true`. Any response at all means the process is up. |

## `GET /v1/schema`

Returns [JSON Schema](https://json-schema.org/draft/2020-12) (draft 2020-12) for the two job request bodies and the result document, generated from the same definitions the service validates against. Use it to generate client types or to validate result documents.

It does **not** cover the other response bodies (resorts, weather, jobs, health, errors). Those are described only in these documents.

```json
{
  "schemaVersion": "groomrs-snow-model/v1",
  "initializeRequest": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "…": "…"
  },
  "refreshRequest": { "…": "…" },
  "resultDocument": { "…": "…" }
}
```

| Field               | Type   | Description                                                                                         |
| ------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `schemaVersion`     | string | Contract version, `groomrs-snow-model/v1`.                                                          |
| `initializeRequest` | object | JSON Schema of the [initialize](#post-v1resortsidseasonsseasoninitialize) request body.             |
| `refreshRequest`    | object | JSON Schema of the [refresh](#post-v1resortsidrefresh) request body, with `horizonHours`'s default. |
| `resultDocument`    | object | JSON Schema of the [result document](result-document.md).                                           |

## `GET /v1/resorts`

Lists every configured resort.

**Response** `200`

```json
{
  "resorts": [
    {
      "id": "vail-co",
      "name": "Vail",
      "…": "see GET /v1/resorts/:id"
    }
  ]
}
```

| Field     | Type  | Description                                                                                                          |
| --------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `resorts` | array | Every configured resort, ordered by id. Each entry has the same fields as [`GET /v1/resorts/:id`](#get-v1resortsid). |

## `GET /v1/resorts/:id`

**Path parameters**

| Name | Description               |
| ---- | ------------------------- |
| `id` | Resort id, e.g. `vail-co` |

**Response** `200`

```json
{
  "id": "vail-co",
  "name": "Vail",
  "location": {
    "country": "US",
    "region": "Colorado",
    "latitude": 39.639,
    "longitude": -106.374,
    "timezone": "America/Denver"
  },
  "hemisphere": "north",
  "elevationsM": { "base": 2475, "summit": 3527 },
  "season": {
    "typicalOpening": "11-14",
    "typicalClosing": "04-19",
    "spinupDays": 75
  },
  "weather": { "provider": "open-meteo", "model": "ecmwf_ifs025" },
  "points": [
    { "id": "base", "elevationM": 2475 },
    { "id": "mid", "elevationM": 3001 },
    { "id": "summit", "elevationM": 3527 }
  ],
  "configVersion": "793ded04f3cd",
  "sources": ["https://en.wikipedia.org/wiki/Vail_Ski_Resort"]
}
```

| Field                   | Type     | Description                                                                                       |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `id`                    | string   | Resort id (lowercase letters, digits, hyphens).                                                   |
| `name`                  | string   | Display name.                                                                                     |
| `location.country`      | string   | ISO 3166-1 alpha-2 country code.                                                                  |
| `location.region`       | string   | State, province or region.                                                                        |
| `location.latitude`     | number   | Degrees, WGS 84.                                                                                  |
| `location.longitude`    | number   | Degrees, WGS 84.                                                                                  |
| `location.timezone`     | string   | IANA time zone, for displaying times locally. The API itself is always UTC.                       |
| `hemisphere`            | string   | `north` or `south`; determines the [season id format](overview.md#seasons).                       |
| `elevationsM.base`      | number   | Base elevation, m.                                                                                |
| `elevationsM.summit`    | number   | Summit elevation, m.                                                                              |
| `season.typicalOpening` | string   | Typical opening day, `MM-DD`.                                                                     |
| `season.typicalClosing` | string   | Typical closing day, `MM-DD`.                                                                     |
| `season.spinupDays`     | integer  | Default number of days before `typicalOpening` that a spin-up starts from bare ground.            |
| `weather.provider`      | string   | Always `open-meteo`.                                                                              |
| `weather.model`         | string   | Open-Meteo weather model used for this resort, e.g. `ecmwf_ifs025`.                               |
| `points[]`              | array    | The [model points](overview.md#resorts-and-model-points) for this resort, low to high.            |
| `points[].id`           | string   | `base`, `mid` or `summit`.                                                                        |
| `points[].elevationM`   | number   | Elevation of the modelled column, m.                                                              |
| `configVersion`         | string   | 12-hex-character hash of the configuration; see [Overview](overview.md#resorts-and-model-points). |
| `sources`               | string[] | URLs the resort's figures were taken from.                                                        |

**Errors**: `404 not_found` if the resort doesn't exist.

## `GET /v1/resorts/:id/weather`

Returns the hourly weather the model would use for one point, normalized to metric. This call is **synchronous** and reads from the same cache the model runs use. Past months are fetched once and kept; recent and future hours are refetched at most hourly.

**Query parameters**

| Name    | Default                      | Description                                                                                                          |
| ------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `point` | the resort's first point     | One of the resort's point ids.                                                                                       |
| `start` | start of the current UTC day | A time, preferably ISO-8601 UTC. Rounded down to the hour. See [Times](overview.md#times) for what else is accepted. |
| `end`   | `start` + 72 hours           | A time, **inclusive**. Rounded down to the hour. Must be ≥ `start`.                                                  |

`end` minus `start` may be at most **744 hours (31 days)**. This is checked before rounding, so a window can return up to 745 hours. The window can reach as far into the future as the forecast goes: 14 days from the start of the current UTC day.

The first request for a month that isn't cached yet fetches it from Open-Meteo and can take noticeably longer.

**Example**

```sh
curl -s 'http://127.0.0.1:8090/v1/resorts/vail-co/weather?point=summit&start=2026-01-20T00:00:00Z&end=2026-01-20T02:00:00Z'
```

**Response** `200`

```json
{
  "resortId": "vail-co",
  "point": { "id": "summit", "elevationM": 3527 },
  "provider": "open-meteo",
  "model": "ecmwf_ifs025",
  "retrievedAt": "2026-10-11T16:26:03.868Z",
  "hours": [
    {
      "time": "2026-01-20T00:00:00.000Z",
      "airTempC": -12.7,
      "relativeHumidityPct": 57,
      "windSpeedMs": 1.04,
      "windDirectionDeg": 253,
      "shortwaveWm2": 105,
      "precipitationMm": 0,
      "rainMm": 0,
      "snowfallCm": 0,
      "cloudCoverPct": 0,
      "surfacePressureHpa": 657.8
    }
  ]
}
```

| Field              | Type   | Description                                                                                                                                                                                                            |
| ------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resortId`         | string | Resort id.                                                                                                                                                                                                             |
| `point.id`         | string | The point the weather is for: `base`, `mid` or `summit`.                                                                                                                                                               |
| `point.elevationM` | number | The point's elevation, m. Open-Meteo adjusts the weather to this elevation with [statistical downscaling](https://open-meteo.com/en/docs/ecmwf-api), so the summit is colder than the base even in the same grid cell. |
| `provider`         | string | Always `open-meteo`.                                                                                                                                                                                                   |
| `model`            | string | Open-Meteo weather model, for example `ecmwf_ifs025` ([ECMWF IFS 0.25°](https://open-meteo.com/en/docs/ecmwf-api)).                                                                                                    |
| `retrievedAt`      | string | When the weather was fetched from Open-Meteo. If the window spans several cached months, the oldest of their retrieval times.                                                                                          |
| `hours`            | array  | One entry per hour from `start` to `end` inclusive, so the example returns 3 and the default window 73. Each entry has the fields of [`forcing`](result-document.md#forcing-hourly-weather) in a result document.      |

**Errors**

| Status | `error`               | When                                                                                         |
| ------ | --------------------- | -------------------------------------------------------------------------------------------- |
| `404`  | `not_found`           | Unknown resort.                                                                              |
| `400`  | `bad_request`         | Unknown `point`; `start`/`end` not parseable or `end < start`; window longer than 744 hours. |
| `502`  | `weather_unavailable` | Open-Meteo failed, or `end` is beyond the forecast's reach.                                  |

## `POST /v1/resorts/:id/seasons/:season/initialize`

Creates an **initialize** job: a seasonal spin-up from bare ground through the start of `asOf`'s UTC day, for every model point. See [Jobs](jobs.md) for the lifecycle.

**Path parameters**

| Name     | Description                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| `id`     | Resort id.                                                                                                 |
| `season` | Season id: `2025-26` for a northern resort, `2026` for a southern one. See [Seasons](overview.md#seasons). |

**Request body**

```json
{
  "idempotencyKey": "initialize/vail-co/2025-26",
  "asOf": "2026-02-01T12:00:00Z",
  "spinupDays": 30
}
```

| Field            | Type    | Required | Description                                                                                                                                                                  |
| ---------------- | ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotencyKey` | string  | yes      | 1–200 characters. See [Idempotency](jobs.md#idempotency).                                                                                                                    |
| `asOf`           | string  | no       | ISO-8601 UTC (`Z`). The state is built through the start of this UTC day. Defaults to the time the job is created. Must not be in the future, and must fall within `season`. |
| `spinupDays`     | integer | no       | 1–365. Overrides the resort's `season.spinupDays`: the spin-up starts this many days before the season's typical opening.                                                    |

**Responses**

- `202 Accepted`: a new job was created.
- `200 OK`: a job with this `idempotencyKey` and the same request already exists; it is returned unchanged.

Both carry a `Location: /v1/jobs/<jobId>` header (the URL to poll) and this body:

```json
{
  "jobId": "9465f067-3c87-4485-bb32-0d1af5c3fd6c",
  "created": true,
  "job": {
    "id": "9465f067-3c87-4485-bb32-0d1af5c3fd6c",
    "kind": "initialize",
    "resortId": "vail-co",
    "season": "2025/26",
    "status": "queued",
    "progress": {},
    "error": null,
    "resultId": null,
    "attempts": 0,
    "asOf": "2026-02-01T12:00:00.000Z",
    "createdAt": "2026-10-11T16:20:00.000Z",
    "startedAt": null,
    "finishedAt": null
  }
}
```

| Field     | Type          | Description                                                                                                                              |
| --------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `jobId`   | string (UUID) | The job's id. Poll [`GET /v1/jobs/:id`](#get-v1jobsid) with it.                                                                          |
| `created` | boolean       | `true` if this request created the job (`202`). `false` if an existing job with the same idempotency key was returned (`200`).           |
| `job`     | object        | The job as it is now, with the same fields as [`GET /v1/jobs/:id`](#get-v1jobsid). When `created` is `false` it may already be finished. |

An initialize job never produces a result document, so its `resultId` stays `null`.

**Errors**

| Status | `error`                | When                                                                                                                |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `404`  | `not_found`            | Unknown resort.                                                                                                     |
| `400`  | `bad_request`          | Season id has the wrong form for the hemisphere; body fails validation; `asOf` is in the future or not in `season`. |
| `409`  | `idempotency_conflict` | `idempotencyKey` was already used for a different request. `details.jobId` names the existing job.                  |

A request can be accepted and the job still end up `blocked` with reason `before_spinup`, when `asOf`'s day is not after the spin-up start (typical opening minus `spinupDays`). See [Jobs](jobs.md#blocked-reasons).

## `POST /v1/resorts/:id/refresh`

Creates a **refresh** job. For each point it:

1. Finds the saved state for the season containing `asOf`: the newest checkpoint at or before the start of `asOf`'s UTC day, from the most recently completed initialize job for that season and the resort's current `configVersion`.
2. Advances that state with past weather to the start of `asOf`'s UTC day, if it isn't there already, and saves the result as a new checkpoint.
3. Runs SNOWPACK `horizonHours` forward from a copy of that state. The forecast is not saved as state.

When the job completes, its `resultId` names the [result document](result-document.md).

**Request body**

```json
{
  "idempotencyKey": "refresh/vail-co/2026-02-03",
  "asOf": "2026-02-03T06:00:00Z",
  "horizonHours": 48
}
```

| Field            | Type    | Required | Default | Description                                                                                                                                |
| ---------------- | ------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `idempotencyKey` | string  | yes      |         | 1–200 characters. See [Idempotency](jobs.md#idempotency).                                                                                  |
| `asOf`           | string  | no       | now     | ISO-8601 UTC (`Z`). Must not be in the future. The forecast window starts at the start of this UTC day, and the season is derived from it. |
| `horizonHours`   | integer | no       | `168`   | 1–168. Length of the forecast window.                                                                                                      |

The result's window runs from `startOfUtcDay(asOf)` to `startOfUtcDay(asOf) + horizonHours`. Because `asOf` is rounded down to midnight UTC, the first hours of the window may already be in the past. `provenance.weatherKind` in the result tells you whether the window's weather was archived, forecast or a mix.

To run a **hindcast**, set `asOf` in the past. If the whole window has passed, the "forecast" uses archived weather.

**Responses**: `202` or `200`, with the same body and `Location` header as [initialize](#post-v1resortsidseasonsseasoninitialize), with `kind: "refresh"`.

**Errors**

| Status | `error`                | When                                                       |
| ------ | ---------------------- | ---------------------------------------------------------- |
| `404`  | `not_found`            | Unknown resort.                                            |
| `400`  | `bad_request`          | Body fails validation; `asOf` is in the future.            |
| `409`  | `idempotency_conflict` | `idempotencyKey` was already used for a different request. |

If the season was never initialized (or was initialized under an older `configVersion`), the request is accepted and the job ends `blocked` with reason `not_initialized`. See [Jobs](jobs.md#blocked-reasons).

## `GET /v1/jobs/:id`

**Path parameters**: `id`, the job id (UUID) returned when the job was created.

**Response** `200`

```json
{
  "id": "05557bb1-a9b7-4971-aea4-438dfb82559d",
  "kind": "refresh",
  "resortId": "vail-co",
  "season": "2025/26",
  "status": "complete",
  "progress": { "base": "complete", "mid": "complete", "summit": "complete" },
  "error": null,
  "resultId": "69a02752-d7e8-4eb1-b955-09e54f4c4259",
  "attempts": 1,
  "asOf": "2026-02-03T06:00:00.000Z",
  "createdAt": "2026-10-11T16:33:12.394Z",
  "startedAt": "2026-10-11T16:33:12.399Z",
  "finishedAt": "2026-10-11T16:33:13.032Z"
}
```

| Field        | Type           | Description                                                                                                       |
| ------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`         | string (UUID)  | Job id.                                                                                                           |
| `kind`       | string         | `initialize` or `refresh`.                                                                                        |
| `resortId`   | string         | Resort id.                                                                                                        |
| `season`     | string         | Season, in response form (`2025/26` or `2026`).                                                                   |
| `status`     | string         | `queued`, `running`, `blocked`, `complete` or `failed`. See [Jobs](jobs.md#statuses).                             |
| `progress`   | object         | Map of point id → `running` or `complete`. Points not yet started are absent.                                     |
| `error`      | object \| null | Set when `status` is `blocked` or `failed`: `{ reason, message, details? }`. See [Jobs](jobs.md#blocked-reasons). |
| `resultId`   | string \| null | Result document id. Set only for a `complete` refresh job.                                                        |
| `attempts`   | integer        | Number of times a worker has started the job (at most 3).                                                         |
| `asOf`       | string         | The resolved `asOf`. When the request omitted it, this is the time the job was created.                           |
| `createdAt`  | string         | When the job was created.                                                                                         |
| `startedAt`  | string \| null | When a worker first started it.                                                                                   |
| `finishedAt` | string \| null | When it reached `complete`, `blocked` or `failed`.                                                                |

**Errors**: `404 not_found` if the id is not a UUID or no such job exists.

## `GET /v1/results/:id`

Returns a [result document](result-document.md). Its fields are described there, because the document is large enough to need its own page.

**Path parameters**: `id`, the result id (UUID), from a completed refresh job's `resultId`.

**Query parameters**

| Name             | Description                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profileDepthCm` | Optional non-negative number. Keeps only profile layers whose **top** lies within this many cm of the snow surface (`layer.depthCm <= profileDepthCm`). Everything else in the document is unchanged. An empty value (`?profileDepthCm=`) counts as `0` and keeps only the surface layer. |

Full documents are large, mostly because of the profiles. A 48-hour, three-point Vail result in mid-winter is about 2 MB in full, 0.9 MB with `profileDepthCm=20` and 0.3 MB with `profileDepthCm=5`. A 168-hour result is about 3.5 times larger. Pass `profileDepthCm` if you only need the near-surface layers.

**Errors**

| Status | `error`       | When                                           |
| ------ | ------------- | ---------------------------------------------- |
| `404`  | `not_found`   | `id` is not a UUID, or no such result exists.  |
| `400`  | `bad_request` | `profileDepthCm` is not a non-negative number. |

## `GET /v1/resorts/:id/results/latest`

Returns the most recently created result document for a resort, across all seasons. Takes the same `profileDepthCm` query parameter as [`GET /v1/results/:id`](#get-v1resultsid).

"Most recent" means most recently **generated**, not the latest `asOf`. If you ran a hindcast after today's refresh, this returns the hindcast. To be certain which result you get, use the `resultId` from your job.

**Errors**: `404 not_found` (`"no such result"`) if the resort has no results, including when the resort id doesn't exist. `400 bad_request` for an invalid `profileDepthCm`.

## `GET /v1/runs/:runId/files/*path`

Downloads a native file from a single SNOWPACK run, for debugging or for tools that read SNOWPACK formats directly. The formats are documented by SLF in [SNOWPACK data formats](https://snowpack.slf.ch/doc-release/html/snowpackio.html). Each point in a result document lists its run's id and file names under `files`:

```json
"files": {
  "runId": "f5e683d4-3086-402f-8bea-5b85ac617847",
  "names": ["io.ini", "output/BASE_run.haz", "output/BASE_run.ini", "output/BASE_run.pro", "output/BASE_run.smet", "output/BASE_run.sno"]
}
```

Any file in the run directory can be fetched, including the inputs under `input/` (for example `input/BASE.smet`, the forcing file).

```sh
curl -s http://127.0.0.1:8090/v1/runs/f5e683d4-3086-402f-8bea-5b85ac617847/files/output/BASE_run.pro
```

**Response** `200`, `content-type: text/plain; charset=utf-8`, with the file's contents. These files are in SNOWPACK's **native SI units** (K, m, fractions), not the API's metric units.

| File                                         | Contents                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `io.ini`                                     | The SNOWPACK and [MeteoIO](https://meteoio.slf.ch/doc-release/html/index.html) configuration used for the run.            |
| `input/<POINT>.smet`                         | Weather forcing in [SMET](https://meteoio.slf.ch/doc-release/html/smetio.html), MeteoIO's plain-text station data format. |
| `input/<POINT>.sno`                          | The initial snowpack state ([`.sno` format](https://snowpack.slf.ch/doc-release/html/snowpackio.html)).                   |
| `output/<POINT>_run.smet`                    | SNOWPACK's hourly time series ([fluxes time series](https://snowpack.slf.ch/doc-release/html/met_format.html)).           |
| `output/<POINT>_run.pro`                     | Snow profiles ([`.pro` format](https://snowpack.slf.ch/doc-release/html/pro_format.html)).                                |
| `output/<POINT>_run.sno`                     | The final snowpack state.                                                                                                 |
| `output/<POINT>_run.haz`                     | SNOWPACK's hazard output ([`.haz` format](https://snowpack.slf.ch/doc-release/html/snowpackio.html)).                     |
| `output/<POINT>_run.ini`                     | The complete configuration as SNOWPACK resolved it, defaults included.                                                    |
| `weather-sources.json`                       | The Open-Meteo requests whose responses went into the forcing, with their retrieval times. Not listed in `names`.         |
| `snowpack.stdout.log`, `snowpack.stderr.log` | SNOWPACK's console output, for debugging a failed run. Not listed in `names`.                                             |

`<POINT>` is the point id in upper case (`BASE`, `MID`, `SUMMIT`).

**Errors**: `404 not_found` if `runId` is not a UUID, the path leaves the run directory, or the file doesn't exist.
