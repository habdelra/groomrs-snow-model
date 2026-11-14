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
| `POST` | [`/v1/resorts/:id/observations`](#post-v1resortsidobservations)                          | Store a batch of observations                 |
| `GET`  | [`/v1/resorts/:id/observations/latest`](#get-v1resortsidobservationslatest)              | The newest stored observation of each kind    |
| `GET`  | [`/v1/resorts/:id/observations`](#get-v1resortsidobservations)                           | List stored observations                      |
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
    "migrationHead": "1794676594559_add-observations"
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

Returns [JSON Schema](https://json-schema.org/draft/2020-12) (draft 2020-12) for the two job request bodies, the observation batch body and the result document, generated from the same definitions the service validates against. Use it to generate client types or to validate result documents.

It does **not** cover the other response bodies (resorts, weather, jobs, observation responses, health, errors). Those are described only in these documents.

```json
{
  "schemaVersion": "groomrs-snow-model/v1",
  "initializeRequest": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "…": "…"
  },
  "refreshRequest": { "…": "…" },
  "observationBatchRequest": { "…": "…" },
  "resultDocument": { "…": "…" }
}
```

| Field                     | Type   | Description                                                                                         |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `schemaVersion`           | string | Contract version, `groomrs-snow-model/v1`.                                                          |
| `initializeRequest`       | object | JSON Schema of the [initialize](#post-v1resortsidseasonsseasoninitialize) request body.             |
| `refreshRequest`          | object | JSON Schema of the [refresh](#post-v1resortsidrefresh) request body, with `horizonHours`'s default. |
| `observationBatchRequest` | object | JSON Schema of the [observation batch](#post-v1resortsidobservations) request body.                 |
| `resultDocument`          | object | JSON Schema of the [result document](result-document.md).                                           |

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
3. On a **managed** refresh only, brings the point's managed snowpack to the start of `asOf`'s UTC day: the stored grooming, snowmaking and base-depth observations applied one UTC day at a time from the season's spin-up state. Days already run with the same inputs are reused. See [Jobs: managed refreshes](jobs.md#managed-refreshes).
4. Runs SNOWPACK `horizonHours` forward from a copy of that state (the managed one on a managed refresh). The forecast is not saved as state.

When the job completes, its `resultId` names the [result document](result-document.md).

**Request body**

```json
{
  "idempotencyKey": "refresh/vail-co/2026-02-03",
  "asOf": "2026-02-03T06:00:00Z",
  "horizonHours": 48
}
```

A managed refresh from the live stack, with machine snow predicted over the forecast:

```json
{
  "idempotencyKey": "docs/refresh/blue-mountain-pa/2026-02-20/managed",
  "asOf": "2026-02-20T06:00:00Z",
  "horizonHours": 48,
  "snowmakingForecast": "predicted"
}
```

| Field                | Type    | Required | Default   | Description                                                                                                                                                                                                                                           |
| -------------------- | ------- | -------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotencyKey`     | string  | yes      |           | 1–200 characters. See [Idempotency](jobs.md#idempotency).                                                                                                                                                                                             |
| `asOf`               | string  | no       | now       | ISO-8601 UTC (`Z`). Must not be in the future. The forecast window starts at the start of this UTC day, and the season is derived from it.                                                                                                            |
| `horizonHours`       | integer | no       | `168`     | 1–168. Length of the forecast window.                                                                                                                                                                                                                 |
| `scenario`           | string  | no       | see below | `natural`: weather only. `managed`: weather plus the stored observations, applied as grooming and machine snow. See [Observations](../observations.md).                                                                                               |
| `groomingDefault`    | string  | no       | `none`    | What a managed run assumes on a UTC day with no `groomed` or `not_groomed` observation, and on every night of the forecast after the first day. `none`: no grooming. `nightly`: one pass at 04:00 resort time. Ignored on a natural refresh.          |
| `snowmakingForecast` | string  | no       | `none`    | `none`: no machine snow over the forecast. `predicted`: add the machine snow the resort is likely to make, from how much of the recent cold it used (see [`managed.forecast.snowmaking`](result-document.md#forecast)). Ignored on a natural refresh. |

**`scenario`'s default** is `managed` when the service holds any observation for this resort in the season containing `asOf` (an observation's season is the one its `validFrom` falls in), and `natural` otherwise. It is resolved when the job is created and stored with it, so a retry with the same key does the same work even if observations have arrived since. To apply newly stored observations, refresh with a new key. Because the default can change under you, state `scenario` when you need a particular one. The job body (`GET /v1/jobs/:id`) doesn't show the resolved scenario; the result's [`scenario`](result-document.md#top-level) does.

The result's window runs from `startOfUtcDay(asOf)` to `startOfUtcDay(asOf) + horizonHours`. Because `asOf` is rounded down to midnight UTC, the first hours of the window may already be in the past. `provenance.weatherKind` in the result tells you whether the window's weather was archived, forecast or a mix.

To run a **hindcast**, set `asOf` in the past. If the whole window has passed, the "forecast" uses archived weather.

**Responses**: `202` or `200`, with the same body and `Location` header as [initialize](#post-v1resortsidseasonsseasoninitialize), with `kind: "refresh"`.

**Errors**

| Status | `error`                | When                                                                                                                               |
| ------ | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `404`  | `not_found`            | Unknown resort.                                                                                                                    |
| `400`  | `bad_request`          | Body fails validation (including an unknown `scenario`, `groomingDefault` or `snowmakingForecast` value); `asOf` is in the future. |
| `409`  | `idempotency_conflict` | `idempotencyKey` was already used for a different request.                                                                         |

If the season was never initialized (or was initialized under an older `configVersion`), the request is accepted and the job ends `blocked` with reason `not_initialized`. A managed refresh needs the same initialized season. See [Jobs](jobs.md#blocked-reasons).

## `POST /v1/resorts/:id/observations`

Stores a batch of grooming, snowmaking and base-depth observations for one resort. No model runs: the next [managed refresh](#post-v1resortsidrefresh) applies them. [Observations](../observations.md) explains how each kind is used.

Send only what the service hasn't seen. [`GET /v1/resorts/:id/observations/latest`](#get-v1resortsidobservationslatest) says what it holds. Send "nothing seen" records too (a camera that couldn't tell, a report with no depth): they are stored like any other, and never read as "not groomed" or "no snow".

Records are stored as received and never deleted. Sending a `key` the resort already has, with different content, stores a new **revision** of it; the highest revision is the one in force. Sending the same content again changes nothing.

**Path parameters**: `id`, the resort id.

**Request body** (from the live stack)

```json
{
  "idempotencyKey": "docs/blue-mountain-pa/obs/2026-02-21T12:00Z",
  "through": "2026-02-21T12:00:00Z",
  "observations": [
    {
      "kind": "grooming",
      "key": "docs/grooming/bm-summit/2026-02-21",
      "skiDay": "2026-02-21",
      "status": "unknown",
      "validFrom": "2026-02-21T11:00:00Z",
      "elevationM": 470,
      "source": "webcam",
      "observedAt": "2026-02-21T11:00:00Z"
    },
    {
      "kind": "snowmaking",
      "key": "docs/snowmaking/bm-summit/2026-02-21",
      "skiDay": "2026-02-21",
      "status": "not_observed",
      "validFrom": "2026-02-21T00:30:00Z",
      "validTo": "2026-02-21T10:30:00Z",
      "positiveSamples": 0,
      "samples": 12,
      "elevationM": 470,
      "source": "webcam",
      "observedAt": "2026-02-21T10:30:00Z"
    },
    {
      "kind": "base_depth",
      "key": "docs/base_depth/resort/2026-02-21",
      "skiDay": "2026-02-21",
      "status": "not_reported",
      "location": "resort",
      "validFrom": "2026-02-21T11:30:00Z",
      "source": "resort-website",
      "observedAt": "2026-02-21T12:00:00Z"
    }
  ]
}
```

| Field            | Type   | Required | Description                                                                                                                                                                                        |
| ---------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotencyKey` | string | yes      | 1–200 characters. Makes the request safe to retry; see [Idempotency](#observation-batch-idempotency) below. Keys are global across resorts.                                                        |
| `through`        | string | yes      | ISO-8601 UTC (`Z`). You have sent everything observed up to this time. It tells "nothing sent yet" from "nothing observed", and comes back as `provenance.observationsThrough` on managed results. |
| `observations`   | array  | yes      | 0–5000 observations. An empty array is allowed: it only records `through`. No `key` may appear twice.                                                                                              |

Every observation has these fields:

| Field        | Type   | Required | Description                                                                                                                                                                         |
| ------------ | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`       | string | yes      | `grooming`, `snowmaking` or `base_depth`.                                                                                                                                           |
| `key`        | string | yes      | 1–200 characters. The record's identity on your side, unique within the resort. Sending it again with different content amends it.                                                  |
| `skiDay`     | string | yes      | `YYYY-MM-DD`, the resort-local riding day the observation is about. Stored and returned; the model places an observation by `validFrom`, not `skiDay`.                              |
| `status`     | string | yes      | Depends on `kind`; see below.                                                                                                                                                       |
| `validFrom`  | string | yes      | ISO-8601 UTC (`Z`). When it happened: the sighting, the start of a snowmaking window, or when the resort updated its report. The model applies grooming to the UTC day it falls in. |
| `validTo`    | string | no       | ISO-8601 UTC (`Z`). End of a window, not before `validFrom`. Leave it out for a point in time.                                                                                      |
| `observedAt` | string | yes      | ISO-8601 UTC (`Z`). When the observation was made, which can be later than `validFrom`.                                                                                             |
| `source`     | string | yes      | `webcam`, `resort-website` or `human`.                                                                                                                                              |
| `location`   | string | no       | `base`, `mid`, `summit` or `resort`. Which model point it applies to; see below.                                                                                                    |
| `elevationM` | number | no       | Elevation the observation was made at, m. Used when `location` is absent.                                                                                                           |
| `note`       | string | no       | Up to 2000 characters of free text. Stored and returned, never interpreted.                                                                                                         |

Fields by kind:

| `kind`       | `status` values                           | Extra fields                                                                                                                                                                                                                                                           |
| ------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `grooming`   | `groomed`, `not_groomed`, `unknown`       | None. Send `not_groomed` only when someone watched the whole night; a camera that saw nothing sends `unknown`.                                                                                                                                                         |
| `snowmaking` | `observed`, `not_observed`, `unknown`     | `positiveSamples`, `samples`: optional non-negative integers, how many of the images checked showed guns running. Stored, not used by the model.                                                                                                                       |
| `base_depth` | `reported`, `not_reported`, `unavailable` | `depthCm`: the resort's base depth, 0–2000 cm, **required** when `status` is `reported`. `measuredWhere`: optional, up to 200 characters, where the resort says it measures. `not_reported`: the report was read and had no depth. `unavailable`: it couldn't be read. |

Metric only: convert a resort's inches to cm before sending. Unknown fields are accepted and dropped; they aren't stored.

**Which model point an observation applies to**

| The observation carries          | It applies to                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `location` `base`/`mid`/`summit` | That point if the resort has it. Otherwise the point nearest the resort's base, summit or halfway elevation (`mid`). |
| `location` `resort`, or nothing  | Every point, unless it has `elevationM`.                                                                             |
| `elevationM` (no `location`)     | The point nearest that elevation.                                                                                    |

Each observation is stored in the season its `validFrom` falls in.

**Responses**

- `201 Created`: a new batch was stored.
- `200 OK`: a retry of a batch already stored. The body is the original response, unchanged.

There's no `Location` header. The `201` for the batch above:

```json
{
  "batchId": "2e650e03-1a05-4181-ab78-bf1aa5605c6e",
  "resort": "blue-mountain-pa",
  "through": "2026-02-21T12:00:00.000Z",
  "counts": { "accepted": 3, "amended": 0, "unchanged": 0 },
  "results": [
    {
      "key": "docs/grooming/bm-summit/2026-02-21",
      "outcome": "accepted",
      "revision": 1
    },
    {
      "key": "docs/snowmaking/bm-summit/2026-02-21",
      "outcome": "accepted",
      "revision": 1
    },
    {
      "key": "docs/base_depth/resort/2026-02-21",
      "outcome": "accepted",
      "revision": 1
    }
  ],
  "earliestAffected": "2026-02-21T00:30:00.000Z"
}
```

A later batch (new idempotency key) that resends all three, with a staff note added to the grooming record:

```json
{
  "batchId": "f7596c82-9891-4b84-9fa9-81fc3fe98996",
  "resort": "blue-mountain-pa",
  "through": "2026-02-21T15:00:00.000Z",
  "counts": { "accepted": 0, "amended": 1, "unchanged": 2 },
  "results": [
    {
      "key": "docs/grooming/bm-summit/2026-02-21",
      "outcome": "amended",
      "revision": 2
    },
    {
      "key": "docs/snowmaking/bm-summit/2026-02-21",
      "outcome": "unchanged",
      "revision": 1
    },
    {
      "key": "docs/base_depth/resort/2026-02-21",
      "outcome": "unchanged",
      "revision": 1
    }
  ],
  "earliestAffected": "2026-02-21T11:00:00.000Z"
}
```

| Field                | Type           | Description                                                                                                                                                               |
| -------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batchId`            | string (UUID)  | Id of the stored batch.                                                                                                                                                   |
| `resort`             | string         | Resort id.                                                                                                                                                                |
| `through`            | string         | The request's `through`, normalized to `…T12:00:00.000Z` form.                                                                                                            |
| `counts.accepted`    | integer        | Records with a key the resort didn't have, stored as revision 1.                                                                                                          |
| `counts.amended`     | integer        | Records whose content differed from the revision in force, stored as the next revision.                                                                                   |
| `counts.unchanged`   | integer        | Records identical to the revision in force. Nothing was stored for them.                                                                                                  |
| `results[]`          | array          | One entry per observation, in request order.                                                                                                                              |
| `results[].key`      | string         | The observation's `key`.                                                                                                                                                  |
| `results[].outcome`  | string         | `accepted`, `amended` or `unchanged`.                                                                                                                                     |
| `results[].revision` | integer        | The revision now in force for that key.                                                                                                                                   |
| `earliestAffected`   | string \| null | The earliest `validFrom` among the accepted and amended records; `null` when nothing changed. The next managed refresh re-runs the managed snowpack from that UTC day on. |

"Different content" is compared field by field on the validated record, with times compared as strings: changing `"2026-02-21T11:30:00Z"` to `"2026-02-21T11:30:00.000Z"` amends a record even though the instant is the same. Send times in one form.

### Observation batch idempotency

- **Same key, same body**: `200` with the stored response. Nothing is stored again. Unknown fields don't count, since they are dropped before comparing.
- **Same key, different body** (including a different `through`, or the same body sent to another resort): `409 idempotency_conflict`. This `409` has no `details`.
- **New key**: the batch is processed and `201` returned, even if every record is `unchanged`.

**Errors**

| Status | `error`                | When                                                                                                                                                                                                                                                  |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `404`  | `not_found`            | Unknown resort.                                                                                                                                                                                                                                       |
| `400`  | `bad_request`          | Body fails validation: a missing field, an unknown `kind`, `status`, `source` or `location`, a time not in UTC `Z` form, a `reported` base depth without `depthCm`, more than 5000 records; a `key` twice in the batch; `validTo` before `validFrom`. |
| `409`  | `idempotency_conflict` | `idempotencyKey` was already used for a different batch.                                                                                                                                                                                              |

## `GET /v1/resorts/:id/observations/latest`

What the service holds for a resort: the newest record of each kind, and the latest `through` you stated. Use it to send only what is newer. Covers every season.

**Path parameters**: `id`, the resort id.

**Response** `200` (from the live stack, after the batches above)

```json
{
  "resort": "blue-mountain-pa",
  "through": "2026-02-21T15:00:00.000Z",
  "lastChangedAt": "2026-11-14T22:13:39.460Z",
  "latest": {
    "grooming": {
      "key": "docs/grooming/bm-summit/2026-02-21",
      "kind": "grooming",
      "note": "Staff: the summit camera was iced over; no call either way.",
      "skiDay": "2026-02-21",
      "source": "human",
      "status": "unknown",
      "validFrom": "2026-02-21T11:00:00Z",
      "elevationM": 470,
      "observedAt": "2026-02-21T14:45:00Z",
      "revision": 2,
      "season": "2025/26",
      "receivedAt": "2026-11-14T22:13:39.460Z"
    },
    "snowmaking": { "key": "docs/snowmaking/bm-summit/2026-02-21", "…": "…" },
    "base_depth": { "key": "docs/base_depth/resort/2026-02-21", "…": "…" }
  },
  "counts": { "grooming": 9, "snowmaking": 5, "base_depth": 14 }
}
```

A resort with nothing stored (El Colorado on the live stack):

```json
{
  "resort": "el-colorado-cl",
  "through": null,
  "lastChangedAt": null,
  "latest": { "grooming": null, "snowmaking": null, "base_depth": null },
  "counts": { "grooming": 0, "snowmaking": 0, "base_depth": 0 }
}
```

| Field               | Type           | Description                                                                                                                                                                                       |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resort`            | string         | Resort id.                                                                                                                                                                                        |
| `through`           | string \| null | The latest `through` of any batch stored for the resort. A batch with an earlier `through` doesn't lower it. `null` before the first batch.                                                       |
| `lastChangedAt`     | string \| null | When a record was last accepted or amended (a batch of only `unchanged` records doesn't move it). Compare it with when you made a result to tell whether the result used what is stored now.      |
| `latest.grooming`   | object \| null | The record in force whose period ends latest (`validTo`, or `validFrom` for a point in time), as an [observation](#observation-as-returned). It can be a "nothing seen" record. `null` when none. |
| `latest.snowmaking` | object \| null | The same, for snowmaking.                                                                                                                                                                         |
| `latest.base_depth` | object \| null | The same, for base depth.                                                                                                                                                                         |
| `counts`            | object         | Number of keys stored per kind (`grooming`, `snowmaking`, `base_depth`), counting each key once whatever its revisions.                                                                           |

### Observation as returned

An observation in a response is the record as you sent it, after validation (unknown fields dropped, times as the strings you sent), plus:

| Field        | Type    | Description                                                    |
| ------------ | ------- | -------------------------------------------------------------- |
| `revision`   | integer | 1 for the first version of a key, then 2, 3… for amendments.   |
| `season`     | string  | The season `validFrom` falls in, in response form (`2025/26`). |
| `receivedAt` | string  | When this revision was stored.                                 |

Field order isn't preserved.

**Errors**: `404 not_found` if the resort doesn't exist.

## `GET /v1/resorts/:id/observations`

Lists stored observations, oldest `validFrom` first (then by `key` and `revision`), across every season. There's no paging.

**Query parameters**

| Name        | Default   | Description                                                                                                                          |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `kind`      | all kinds | `grooming`, `snowmaking` or `base_depth`.                                                                                            |
| `from`      | none      | ISO-8601 UTC (`Z`). Keeps records whose period ends at or after it (`validTo`, or `validFrom` for a point in time).                  |
| `to`        | none      | ISO-8601 UTC (`Z`). Keeps records whose period starts at or before it. With `from`, this returns every record overlapping the range. |
| `revisions` | `current` | `current`: only the revision in force for each key. `all`: every revision, superseded ones included.                                 |

Unlike the weather endpoint's `start`/`end`, `from` and `to` must be full UTC times with `Z`: a bare date or an offset is `400`.

**Example** (from the live stack)

```sh
curl -s 'http://127.0.0.1:8090/v1/resorts/blue-mountain-pa/observations?kind=grooming&from=2026-02-21T00:00:00Z&revisions=all'
```

**Response** `200`

```json
{
  "resort": "blue-mountain-pa",
  "observations": [
    {
      "key": "docs/grooming/bm-summit/2026-02-21",
      "kind": "grooming",
      "skiDay": "2026-02-21",
      "source": "webcam",
      "status": "unknown",
      "validFrom": "2026-02-21T11:00:00Z",
      "elevationM": 470,
      "observedAt": "2026-02-21T11:00:00Z",
      "revision": 1,
      "season": "2025/26",
      "receivedAt": "2026-11-14T22:13:32.430Z"
    },
    {
      "key": "docs/grooming/bm-summit/2026-02-21",
      "kind": "grooming",
      "note": "Staff: the summit camera was iced over; no call either way.",
      "skiDay": "2026-02-21",
      "source": "human",
      "status": "unknown",
      "validFrom": "2026-02-21T11:00:00Z",
      "elevationM": 470,
      "observedAt": "2026-02-21T14:45:00Z",
      "revision": 2,
      "season": "2025/26",
      "receivedAt": "2026-11-14T22:13:39.460Z"
    }
  ]
}
```

| Field          | Type   | Description                                                                    |
| -------------- | ------ | ------------------------------------------------------------------------------ |
| `resort`       | string | Resort id.                                                                     |
| `observations` | array  | Matching records, each an [observation as returned](#observation-as-returned). |

**Errors**

| Status | `error`       | When                                                                                      |
| ------ | ------------- | ----------------------------------------------------------------------------------------- |
| `404`  | `not_found`   | Unknown resort.                                                                           |
| `400`  | `bad_request` | Unknown `kind` or `revisions` value; `from` or `to` is not an ISO-8601 UTC time with `Z`. |

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

"Most recent" means most recently **generated**, not the latest `asOf`, and natural and managed results count alike. If you ran a hindcast or a `scenario: "natural"` refresh after today's managed one, this returns that. Check the document's `scenario`, or use the `resultId` from your job to be certain which result you get.

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

A managed result's forecast is two SNOWPACK runs per point: the window's first UTC day, then the rest (see [Jobs: managed refreshes](jobs.md#managed-refreshes)). `files` names only the **first** of them, so its `.smet` and `.pro` end at `window.from` + 24 hours, while the result's `met` and `profiles` cover the whole window.

```sh
curl -s http://127.0.0.1:8090/v1/runs/f5e683d4-3086-402f-8bea-5b85ac617847/files/output/BASE_run.pro
```

**Response** `200`, `content-type: text/plain; charset=utf-8`, with the file's contents. These files are in SNOWPACK's **native SI units** (K, m, fractions), not the API's metric units.

| File                                         | Contents                                                                                                                                                                                                                                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `io.ini`                                     | The SNOWPACK and [MeteoIO](https://meteoio.slf.ch/doc-release/html/index.html) configuration used for the run. A managed run that grooms adds a `[TechSnow]` section with `SNOW_GROOMING = true` and the UTC `GROOMING_HOUR`.                                                |
| `input/<POINT>.smet`                         | Weather forcing in [SMET](https://meteoio.slf.ch/doc-release/html/smetio.html), MeteoIO's plain-text station data format. A managed run with machine snow adds a `PSUM_TECH` column, SNOWPACK's technical-snow input: `1.000` on hours with machine snow, `0.000` elsewhere. |
| `input/<POINT>.sno`                          | The initial snowpack state ([`.sno` format](https://snowpack.slf.ch/doc-release/html/snowpackio.html)).                                                                                                                                                                      |
| `output/<POINT>_run.smet`                    | SNOWPACK's hourly time series ([fluxes time series](https://snowpack.slf.ch/doc-release/html/met_format.html)).                                                                                                                                                              |
| `output/<POINT>_run.pro`                     | Snow profiles ([`.pro` format](https://snowpack.slf.ch/doc-release/html/pro_format.html)).                                                                                                                                                                                   |
| `output/<POINT>_run.sno`                     | The final snowpack state.                                                                                                                                                                                                                                                    |
| `output/<POINT>_run.haz`                     | SNOWPACK's hazard output ([`.haz` format](https://snowpack.slf.ch/doc-release/html/snowpackio.html)).                                                                                                                                                                        |
| `output/<POINT>_run.ini`                     | The complete configuration as SNOWPACK resolved it, defaults included.                                                                                                                                                                                                       |
| `weather-sources.json`                       | The Open-Meteo requests whose responses went into the forcing, with their retrieval times. Not listed in `names`.                                                                                                                                                            |
| `snowpack.stdout.log`, `snowpack.stderr.log` | SNOWPACK's console output, for debugging a failed run. Not listed in `names`.                                                                                                                                                                                                |

`<POINT>` is the point id in upper case (`BASE`, `MID`, `SUMMIT`).

**Errors**: `404 not_found` if `runId` is not a UUID, the path leaves the run directory, or the file doesn't exist.
