# Jobs

Model runs take seconds to many minutes, so [initialize](endpoints.md#post-v1resortsidseasonsseasoninitialize) and [refresh](endpoints.md#post-v1resortsidrefresh) don't return results directly. Each creates a **job**. Poll [`GET /v1/jobs/:id`](endpoints.md#get-v1jobsid) until it finishes.

## Statuses

```text
queued ──► running ──► complete
                  ├──► blocked
                  └──► failed
```

| Status     | Final? | Meaning                                                                                                          |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------- |
| `queued`   | no     | Waiting for the worker.                                                                                          |
| `running`  | no     | A worker is running it. `progress` shows which points are `running` or `complete`.                               |
| `complete` | yes    | Done. A refresh job's `resultId` names its result document; an initialize job has no result.                     |
| `blocked`  | yes    | The job can't proceed until something outside it changes. `error.reason` says what. Never retried automatically. |
| `failed`   | yes    | An unexpected error, or the job didn't finish after 3 attempts. `error.message` has the detail.                  |

Jobs run **one at a time**, oldest first, so a job may stay `queued` while earlier ones run. If the service restarts mid-job, the job is picked up again and resumes from the checkpoints it already saved. Each pickup increments `attempts`. After 3 attempts that never finish, the job fails with reason `max_attempts`.

## Polling

Poll every second or two until `status` is no longer `queued` or `running`:

```ts
async function waitForJob(jobId: string): Promise<Job> {
  for (;;) {
    const res = await fetch(`${BASE_URL}/v1/jobs/${jobId}`);
    const job = await res.json();
    if (job.status !== 'queued' && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
```

Typical durations on a developer machine:

- **Initialize**: tens of seconds to several minutes, depending on spin-up length and number of points.
- **Refresh**: a few seconds when the saved state is already near `asOf`. Longer when it has to advance over many days.

## Idempotency

Every job request carries an `idempotencyKey`. It makes `POST`s safe to retry:

- **Same key, same request**: the existing job is returned with `200` and `"created": false`, whatever its status. No new work runs.
- **Same key, different request**: `409 idempotency_conflict`, with the existing job's id in `details.jobId`.
- **New key**: a new job is created with `202` and `"created": true`.

Keys are **global** across resorts, seasons and job kinds, so include all of them in the key, for example `refresh/vail-co/2026-02-03`.

"Same request" means the same job kind, resort, season and **request body as sent**, compared field by field (key order doesn't matter). Defaults aren't filled in before comparing. A body that omits `horizonHours` and one that sends `"horizonHours": 168` are different requests, even though they do the same work. Send the same body every time you retry.

If you omit `asOf`, it is resolved to the time the job is first created, and retries with the same key return that original job. To get a fresh run, use a new key.

Because a finished job is returned as is, retrying a `blocked` or `failed` job needs a **new** key once the cause is fixed.

## Blocked reasons

A `blocked` job has an `error` like this:

```json
{
  "status": "blocked",
  "error": {
    "reason": "not_initialized",
    "message": "no saved state for vail-co/base in season 2025/26 at or before 2026-02-03T00:00:00.000Z for config 793ded04f3cd; initialize the season first"
  }
}
```

| `reason`           | Job kind   | Cause                                                                                                                                                                                    | What to do                                                                                      |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `not_initialized`  | refresh    | No usable saved state: the season was never initialized, the initialize job hasn't completed, it was done under an older `configVersion`, or its checkpoints are all after `asOf`'s day. | Initialize the season (with an `asOf` on or before the refresh's), then refresh with a new key. |
| `before_spinup`    | initialize | `asOf`'s UTC day is not after the spin-up start (typical opening minus `spinupDays`), so there is nothing to spin up.                                                                    | Use a later `asOf` or a larger `spinupDays`.                                                    |
| `weather_coverage` | either     | More than 10% of hours are missing for a required weather variable (air temperature, humidity, wind speed, shortwave or precipitation). `error.details` lists the gaps.                  | Usually an upstream data hole. Try a different window, or wait for the data.                    |
| `unknown_resort`   | either     | The resort was removed from configuration after the job was created.                                                                                                                     | None; the resort no longer exists.                                                              |

For `weather_coverage`, `error.details` is an array:

```json
[{ "variable": "shortwaveWm2", "missingHours": 30, "totalHours": 169 }]
```

## Failed reasons

| `reason`       | Cause                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `error`        | An unexpected error: SNOWPACK crashed or timed out, Open-Meteo was unreachable, and so on. See `message`. |
| `max_attempts` | The job was started 3 times without finishing (for example, the service kept restarting).                 |

Failed jobs aren't retried automatically. Resubmit with a new idempotency key.

## Re-initializing a season

You can initialize the same season more than once, for example with a different `spinupDays`, or after the resort's `configVersion` changes. Each completed initialize job starts a new **lineage** of saved state, identified by the initialize job's id. Refreshes always build on the lineage of the most recently **completed** initialize job for that season and current `configVersion`. Each point's `state.lineageId` in a result document tells you which lineage it used.
