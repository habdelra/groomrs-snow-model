# Observations: grooming, snowmaking and base depth

Boxel gathers three kinds of observation per resort: grooming and snowmaking seen on webcams, and the base depth the resort publishes. GROOMRS staff can also log any of the three by hand, for any day. This document covers how the service receives them, keeps them, and uses them in the snow column it returns.

The Boxel side of the same design is in `groomrs-design/groomrs-system-architecture.md`, section _Observations into the snow model_.

## What the service does

1. **Keeps the observations.** Boxel sends only what the service has not seen. The service stores them per resort, so the history never has to be sent again.
2. **Says what it has.** Boxel asks for the last observation received per kind, and sends everything newer.
3. **Accepts amendments.** An observation for a past day can arrive late, or replace an earlier one. A manual entry is the usual case.
4. **Uses them.** A _managed_ refresh applies them to the snowpack it saves and the forecast it runs from it.

"Nothing seen" is an observation too. A camera that could not tell, or a snow report with no depth on it, is sent and stored like any other record. It is never read as "not groomed" or "zero snow".

## Two snowpacks per point

| Chain   | What it is                                                                                |
| ------- | ----------------------------------------------------------------------------------------- |
| Natural | Weather only. Unchanged from before observations existed.                                 |
| Managed | Weather, plus observed grooming and machine snow. Starts from the season's spin-up state. |

A refresh is managed when the resort has observations for the season, unless the request says `"scenario": "natural"`. A managed result still reports the natural depth beside the managed one, so the caller can say how much of the pack is made.

The managed chain starts at the spin-up state. Observations dated before it are stored but not applied. To apply a longer history, initialize the season with an earlier `asOf`.

## How each observation is used

### Grooming

SNOWPACK can only groom on a fixed schedule: every night at one hour, on or off for a whole run. It cannot be told "groomed Tuesday, not Wednesday".

So the managed chain runs the past **one day per SNOWPACK run**, and sets the switch for each day:

| Observation for that day     | That day's run                                           |
| ---------------------------- | -------------------------------------------------------- |
| `groomed`                    | Grooming on, at the first whole hour after the sighting. |
| `not_groomed`                | Grooming off.                                            |
| `unknown`, or no observation | The request's `groomingDefault`: `none` or `nightly`.    |

Each day's run starts from the state the previous day ended in, so the snowpack carries through.

A pass compacts the top of the pack (layers lighter than 450 kg/m³ get denser, mass is kept) and resets the grains to small rounded ones. It does not mix or move snow.

`groomingDefault: "nightly"` is how the caller passes a resort's usual habit. It grooms at 04:00 resort time on days with no observation, and on every night of the forecast. With `"none"` (the default), nights nobody observed stay ungroomed in the data, and the caller keeps its own rule for them; the GROOMRS forecast pipeline uses `"none"`.

**Last night's grooming.** A result's window starts at 00:00 UTC, so in most time zones the grooming seen "last night" falls a few hours inside it. The forecast's first UTC day therefore runs on its own, with whatever was observed for that day, and the rest of the forecast runs on from where it ended. The two are returned as one series.

### Snowmaking

A webcam rarely sees snowmaking: most of it happens in the dark. So the evidence is ranked:

1. **Base depth says how much.** A reported depth the weather does not explain is machine snow.
2. **Weather says when.** Guns only run when the wet-bulb temperature is low enough. Machine snow is only ever placed on those hours.
3. **Sightings sharpen the timing.** Where guns were seen, those hours are used first.

A `snowmaking` observation with status `observed` turns on one cold hour in four inside its window. That is a modest guess: an observation never says how much was made, and base depth corrects it. `not_observed` and `unknown` say nothing about what happened in the dark and change nothing.

### Base depth

The service never overwrites the snowpack with the resort's figure. It reads the gap as machine snow the model has not accounted for.

For each reading, at each model point it applies to:

1. **Compare.** The modelled depth at the end of the UTC day the reading was reported in, against the reported depth.
2. **Ignore small gaps.** A gap within 5 cm is left alone. A figure in whole inches is no finer than about 2.5 cm.
3. **Close half of it.** The aim is half the gap. A resort's figure is rough, so repeated readings close the gap over a few days.
4. **Add machine snow.** Whole hours of machine snow go on cold hours between the previous reading and this one, at most 14 days back: sighted hours first, then the coldest. The days are run again, the result is measured, and the hour count is adjusted until the depth lands within 2 cm of the aim.
5. **Or take it back.** When the model is deeper than the report, machine-snow hours are removed instead, most recent first. Only machine snow can be removed, so the pack never goes below what the weather left.
6. **Report what is left.** The remaining gap comes back with the result. It is never forced in.

The correction goes into SNOWPACK's own machine-snow input, so SNOWPACK builds the layers with the density and wetness it gives machine snow.

Limits:

- **A resort that makes no snow gets machine snow anyway** if its report is deeper than the model. The service cannot tell a snowmaking gap from a weather error. Do not send base depth for such a resort until that is handled.
- **A resort's base depth is its own measure**, taken where it chooses. No per-resort bias is learned yet.
- **The correction is in depth, not mass.** SNOWPACK 3.7.0 makes machine snow about 100 kg/m³ too light, so a matched depth holds less water than the real pack.

### Which model point

| The observation carries        | It applies to                                |
| ------------------------------ | -------------------------------------------- |
| `location`: base, mid, summit  | That point, or the nearest one by elevation. |
| `location`: resort, or nothing | Every point.                                 |
| `elevationM` only              | The nearest point.                           |

A webcam sees part of the mountain, so its observation speaks for that point's terrain, not for every run.

## Amendments

Each saved managed state carries a hash of every managed input up to its time: each day's grooming hour and machine-snow hours, chained from the spin-up state.

To reach a day, the chain reuses the newest saved state whose hash matches the inputs as they stand now, and runs forward from there. An amended observation changes the hash from its day on, so exactly those days run again. Nothing is invalidated by hand, and older states stay on disk.

A base-depth correction is saved with the hash of the inputs it was worked out against. If earlier inputs change, it is worked out again; otherwise it is reused, so a refresh with nothing new runs no past days at all.

## Storage

Postgres, because observations are small, structured and queried by day. Model data stays in files.

| Table                    | Holds                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `observations`           | Every observation received, append-only. An amendment is a new `revision` of the same `key`; the highest is in force. |
| `observation_batches`    | Each request: its idempotency key, the `through` time it stated, and the answer it got.                               |
| `base_depth_resolutions` | What the model did about one reading at one point: hours added or removed, and the gap left.                          |
| `state_checkpoints`      | Gains `scenario` (natural or managed) and `inputs_hash` for managed states.                                           |

## API

Additions to v1. Nothing existing changed shape.

### `POST /v1/resorts/:id/observations`

Stores a batch. No model runs; the next refresh applies it.

```json
{
  "idempotencyKey": "vail-co/obs/2026-11-14T13:00Z",
  "through": "2026-11-14T13:00:00Z",
  "observations": [
    {
      "kind": "grooming",
      "key": "grooming/vail-eagles-nest/2026-02-16",
      "skiDay": "2026-02-16",
      "status": "groomed",
      "validFrom": "2026-02-16T10:20:00Z",
      "elevationM": 3140,
      "source": "webcam",
      "observedAt": "2026-02-16T10:20:00Z"
    },
    {
      "kind": "snowmaking",
      "key": "snowmaking/bm-summit/2026-01-28",
      "skiDay": "2026-01-28",
      "status": "observed",
      "validFrom": "2026-01-28T00:30:00Z",
      "validTo": "2026-01-28T09:10:00Z",
      "positiveSamples": 6,
      "samples": 10,
      "elevationM": 470,
      "source": "webcam",
      "observedAt": "2026-01-28T09:10:00Z"
    },
    {
      "kind": "base_depth",
      "key": "base_depth/mid/2026-11-14",
      "skiDay": "2026-11-14",
      "status": "reported",
      "depthCm": 45,
      "location": "mid",
      "validFrom": "2026-11-14T12:39:00Z",
      "source": "resort-website",
      "observedAt": "2026-11-14T16:56:00Z"
    }
  ]
}
```

| Field        | Meaning                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| `key`        | The record's identity in Boxel. Sending it again with different content amends it.                       |
| `through`    | Boxel has sent everything observed up to this time. Tells "nothing sent" from "nothing observed".        |
| `validFrom`  | When it happened: the sighting, the start of a snowmaking window, or when the resort updated its report. |
| `validTo`    | The end of a window. Left out for a point in time.                                                       |
| `observedAt` | When Boxel made the observation, which can be later.                                                     |

Statuses:

| Kind         | Statuses                                  |
| ------------ | ----------------------------------------- |
| `grooming`   | `groomed`, `not_groomed`, `unknown`       |
| `snowmaking` | `observed`, `not_observed`, `unknown`     |
| `base_depth` | `reported`, `not_reported`, `unavailable` |

Boxel decides which status a record has. In particular, only a person or a camera that watched the whole night should send `not_groomed`; a camera that saw nothing sends `unknown`.

The response gives each record's outcome (`accepted`, `amended` or `unchanged`) and revision, and `earliestAffected`: the earliest time a new or amended record covers, or null. It is `201` for a new batch and `200` for a retry of the same one. The same idempotency key with a different body is a `409`.

Metric only, like the rest of the contract: Boxel converts a resort's inches before sending.

### `GET /v1/resorts/:id/observations/latest`

The record in force with the latest time, per kind, with the `through` time, how many records are held, and `lastChangedAt`: when a record was last stored or amended. A caller can use `lastChangedAt` to tell whether a result it holds was made from what is stored now. A kind with nothing stored is `null`. The latest record can be a "nothing seen" one.

### `GET /v1/resorts/:id/observations?kind=&from=&to=&revisions=`

Lists what is stored. `revisions=all` includes superseded revisions.

### `POST /v1/resorts/:id/refresh`

Three optional fields:

| Field                | Values               | Default                                                                    |
| -------------------- | -------------------- | -------------------------------------------------------------------------- |
| `scenario`           | `natural`, `managed` | `managed` when the resort has observations for the season, else `natural`. |
| `groomingDefault`    | `none`, `nightly`    | `none`.                                                                    |
| `snowmakingForecast` | `none`, `predicted`  | `none`.                                                                    |

### Snowmaking over the forecast

With `snowmakingForecast: "predicted"` on a managed refresh, the forecast carries machine snow the resort is expected to make. It is a guess from the resort's own recent record, not an observation:

1. Over the 14 days before the forecast, count the hours cold enough to make snow (wet-bulb at or below −2 °C) and the hours the managed chain holds machine snow. Those hours came from observations: guns seen, or a base-depth reading the natural snowpack could not explain.
2. Their ratio is the share of cold hours the resort used, capped at 0.6.
3. On each forecast day, that share of the day's cold hours gets machine snow, coldest hours first, up to the daily limit.
4. The count is scaled down by what a recent machine-snow hour actually left on the ground (managed depth less natural depth, over the recent hours) against the 3 cm a cold hour makes. The past hours were fitted to the resort's reported depth and many were barely cold enough; the coldest hours ahead make several times more. Unscaled, Blue Mountain's summit grew from 50 cm to 117 cm in a week against a resort report of 66 cm.

Nothing is predicted when the resort made no snow in those 14 days (`none_recently`) or when there were fewer than 12 cold hours to judge by (`too_few_cold_hours`). A resort with no snowmaking observations therefore never gets predicted machine snow. The saved state is not touched: only the forecast copy holds the predicted snow, so the next refresh starts from observations again.

The result says what was assumed, per point, in `managed.forecast.snowmaking`: `mode`, the `nights` (day, hours, first and last hour), the `utilisation`, the two counts it came from, `depthPerHourCm`, and the `reason`. A caller must present these as expected, never as seen.

## What comes back

On a managed result:

- **`scenario`** is `managed`, and each point's `state`, `met` and `profiles` are the managed snowpack.
- **Machine-snow layers** have `grainTypeCode` 6 and `grainTypePrimary` `MM`.
- **`provenance.observationsThrough`** is the latest `through` Boxel stated, and `managedRulesVersion` names the rules in `src/observations/plan.ts`.
- **Each point has `managed`:**

| Field                | Holds                                                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `naturalSnowDepthCm` | The undisturbed snowpack's depth at the same time.                                                                                                                                                                                                                                                         |
| `appliedFrom`        | Where the managed chain starts.                                                                                                                                                                                                                                                                            |
| `groomedNights`      | Each pass applied before the window: observed or assumed, who saw it (`webcam` or `human`), and the observation behind it.                                                                                                                                                                                 |
| `forecast`           | Grooming inside the window. `today` is the first UTC day: `observed`, `default` (assumed), `not_groomed` (someone watched and saw none) or `none`, with the time and who saw it. `laterNights` is `nightly` or `none`. `snowmaking` is the machine snow assumed ahead: see _Snowmaking over the forecast_. |
| `technicalSnow`      | Hours of machine snow per UTC day, and whether a sighting or base depth asked for them.                                                                                                                                                                                                                    |
| `baseDepth`          | Each reading: reported and modelled depth before and after, hours added or removed, the gap left, and a note when the correction fell short.                                                                                                                                                               |

The service still returns raw physical data only. Whether a surface is "firm" or a window is "best" stays in Boxel.

## What SNOWPACK can and cannot take

Measured on the installed 3.7.0, on Blue Mountain's summit in January 2026. The `snowpack-runtime` skill has the detail.

- **Grooming** is the `[TechSnow]` keys `SNOW_GROOMING`, `GROOMING_HOUR` and friends. It fires once a day on the step that lands on the hour, in UTC here. The week range is set to the whole year and each day's run decides. The minimum depth is lowered from 0.4 m to 0.1 m so a thin base is still groomed.
- **Machine snow** is a forcing column, `PSUM_TECH`. SNOWPACK makes snow on any step where it is positive, at any temperature.
- **It is not a water amount in practice.** One millimetre per step added about 2.8 mm of water equivalent at a wet-bulb of −10 °C. So the service controls whole hours and measures the depth they give.
- **Small amounts vanish.** Under about 0.6 mm per step nothing is added. An on-hour is four steps of 1 mm, roughly 3 cm of snow when cold.
- **Depth-driven mode is not used.** `ENFORCE_MEASURED_SNOW_HEIGHTS` only adds snow, as natural snowfall, and conflicts with machine snow and grooming.

## Not built yet

- A learned production rate and base-depth bias per resort.
- A flag for resorts that make no snow.
- A snowmaking forecast that knows the resort's plans. The prediction only extends recent behaviour: it does not know a resort has stopped for the season, opened new terrain or run out of water.
- Observations dated before the spin-up state.
