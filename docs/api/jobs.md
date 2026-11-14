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
- **Managed refresh**: the first one in a lineage runs SNOWPACK once per day from the spin-up state, plus a few trial runs per base-depth reading, so it takes longer the further `asOf` is from the spin-up. Later refreshes reuse the saved days (see [Managed refreshes](#managed-refreshes)). On the local stack, a 48-hour Blue Mountain refresh 19 days after the spin-up took about 3 seconds for two points, running the 10 days not yet saved and the trial runs for their base-depth readings.

## Idempotency

Every job request carries an `idempotencyKey`. It makes `POST`s safe to retry:

- **Same key, same request**: the existing job is returned with `200` and `"created": false`, whatever its status. No new work runs.
- **Same key, different request**: `409 idempotency_conflict`, with the existing job's id in `details.jobId`.
- **New key**: a new job is created with `202` and `"created": true`.

Keys are **global** across resorts, seasons and job kinds, so include all of them in the key, for example `refresh/vail-co/2026-02-03`.

"Same request" means the same job kind, resort, season and **request body as sent**, compared value by value (key order doesn't matter). Nothing is normalized before comparing:

- Defaults aren't filled in. A body that omits `horizonHours` and one that sends `"horizonHours": 168` are different requests, even though they do the same work.
- Times are compared as strings. `"2026-02-03T06:00:00Z"` and `"2026-02-03T06:00:00.000Z"` are different requests.
- Unknown fields are accepted without error, but they count. Adding `"note": "retry"` to a retried body makes it a different request.

Send exactly the same body every time you retry.

If you omit `asOf`, it is resolved to the time the job is first created, and retries with the same key return that original job. To get a fresh run, use a new key.

The same holds for a refresh's `scenario`: when the body leaves it out, it is resolved (to `managed` if the resort has observations for the season, else `natural`) when the job is created. A retry returns that job even if observations have arrived since. Observations stored after a refresh job was created don't reach it; refresh again with a new key to apply them. Including the `lastChangedAt` of [`GET /v1/resorts/:id/observations/latest`](endpoints.md#get-v1resortsidobservationslatest) in the key, for example `refresh/blue-mountain-pa/2026-02-20/obs@2026-11-14T22:13:39.460Z`, gives a new key exactly when the stored observations change.

Observation batches have their own idempotency rules, which compare the validated body rather than the body as sent. See [`POST /v1/resorts/:id/observations`](endpoints.md#observation-batch-idempotency).

A refresh without `asOf` also takes its season from the current time. At a season boundary (1 July for northern resorts, 1 January for southern ones):

- A retry with the same key and body gets `409`, because the request now resolves to a different season.
- New refreshes are `blocked` with `not_initialized` until the new season has been initialized.

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

| `reason`           | Job kind   | Cause                                                                                                                                                                                                                                                                                                                  | What to do                                                                                      |
| ------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `not_initialized`  | refresh    | No usable saved state: the season was never initialized, the initialize job hasn't completed, it was done under an older `configVersion`, or its checkpoints are all after `asOf`'s day.                                                                                                                               | Initialize the season (with an `asOf` on or before the refresh's), then refresh with a new key. |
| `before_spinup`    | initialize | `asOf`'s UTC day is not after the spin-up start (typical opening minus `spinupDays`), so there is nothing to spin up.                                                                                                                                                                                                  | Use a later `asOf` or a larger `spinupDays`.                                                    |
| `weather_coverage` | either     | More than 10% of hours are missing for a required weather variable (air temperature, humidity, wind speed, shortwave or precipitation) in any period being simulated: the spin-up, the advance from the checkpoint, any day of the managed snowpack being run, or the forecast window. `error.details` lists the gaps. | Usually an upstream data hole. Try a different window, or wait for the data.                    |
| `unknown_resort`   | either     | The resort was removed from configuration after the job was created.                                                                                                                                                                                                                                                   | None; the resort no longer exists.                                                              |

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

## Managed refreshes

A refresh with `scenario: "managed"` (see [refresh](endpoints.md#post-v1resortsidrefresh)) keeps two snowpacks per point in the same lineage:

| Snowpack | How it advances                                                                                                                                                               |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Natural  | As in any refresh: from the newest natural checkpoint to the start of `asOf`'s day, with past weather only. A managed refresh keeps it current too.                           |
| Managed  | One UTC day per SNOWPACK run, from the season's spin-up state (the lineage's first checkpoint) to the start of `asOf`'s day, each day with its own grooming and machine snow. |

Each saved managed day records a fingerprint of every managed input up to it: each day's grooming hour and machine-snow hours, starting from the spin-up state and the rules version (`provenance.managedRulesVersion`). To reach `asOf`'s day, a refresh reuses the newest saved day whose fingerprint matches the observations as they are stored now, and runs only the days after it. So:

- **Nothing new stored**: no managed days run; only the forecast does.
- **A new or amended observation**: the days whose inputs it changes run again, and every day after them. For grooming and snowmaking that starts at the observation's own UTC day (never before the batch's `earliestAffected`). A base-depth reading can reach further back, because its correction places machine snow on the 14 days before it. An amendment that changes no input (a new `note`, say) runs nothing. Nothing needs invalidating by hand.
- **A base-depth reading** is answered by up to four trials that add or remove machine-snow hours, each re-running the days it changes. The answer is saved and reused until something before it changes.
- **`groomingDefault`** is part of the inputs: switching between `none` and `nightly` builds a separate set of managed days.
- **Re-initializing** starts a new lineage, so the managed snowpack starts again from the new spin-up state (`managed.appliedFrom` in the result).

The forecast then runs from the managed state in two parts, the window's first UTC day and the rest (see [`managed.forecast`](result-document.md#forecast)), and is never saved. A managed refresh blocks or fails for the same reasons as a natural one; there are no extra `blocked` or `failed` reasons.

## Re-initializing a season

You can initialize the same season more than once, for example with a different `spinupDays`, or after the resort's `configVersion` changes. Each completed initialize job starts a new **lineage** of saved state, identified by the initialize job's id. Refreshes always build on the lineage of the most recently **completed** initialize job for that season and current `configVersion`. Each point's `state.lineageId` in a result document tells you which lineage it used. A new lineage also restarts the managed snowpack from its spin-up state: observations dated before the new spin-up's `asOf` day are kept but no longer applied.
