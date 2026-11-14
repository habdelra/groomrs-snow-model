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

So the managed chain runs the past **one UTC day per SNOWPACK run**, and sets the switch for each day. An observation belongs to the UTC day its `validFrom` falls in (not its `skiDay`):

| Observations for that UTC day | That day's run                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Any `groomed`                 | Grooming on, at the first whole hour at or after the last sighting (kept within 01:00–23:00 UTC). |
| `not_groomed`, no `groomed`   | Grooming off.                                                                                     |
| Only `unknown`, or none       | The request's `groomingDefault`: `none` or `nightly`.                                             |

Each day's run starts from the state the previous day ended in, so the snowpack carries through.

A pass compacts the top of the pack (layers lighter than 450 kg/m³ get denser, mass is kept) and resets the grains to small rounded ones. It does not mix or move snow.

`groomingDefault: "nightly"` is how the caller passes a resort's usual habit. It grooms at 04:00 resort time on days with no `groomed` or `not_groomed` observation, and on every night of the forecast after the first day. With `"none"` (the default), nights nobody observed stay ungroomed in the data, and the caller keeps its own rule for them; the GROOMRS forecast pipeline uses `"none"`.

**Last night's grooming.** A result's window starts at 00:00 UTC, so in most time zones the grooming seen "last night" falls a few hours inside it. The forecast's first UTC day therefore runs on its own, with whatever was observed for that day, and the rest of the forecast runs on from where it ended. The two are returned as one series.

### Snowmaking

A webcam rarely sees snowmaking: most of it happens in the dark. So the evidence is ranked:

1. **Base depth says how much.** A reported depth the weather does not explain is machine snow.
2. **Weather says when.** Guns only run when the wet-bulb temperature is low enough. Machine snow is only ever placed on hours at or below −2.5 °C wet-bulb.
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

### Snowmaking over the forecast

With `snowmakingForecast: "predicted"` on a managed refresh, the forecast carries machine snow the resort is expected to make. It is a guess from the resort's own recent record, not an observation:

1. Over the 14 days before the forecast, count the hours cold enough to make snow (wet-bulb at or below −2.5 °C) and the hours the managed chain holds machine snow. Those hours came from observations: guns seen, or a base-depth reading the natural snowpack could not explain.
2. Their ratio is the share of cold hours the resort used, capped at 0.6.
3. On each forecast day, that share of the day's cold hours gets machine snow, coldest hours first, up to the daily limit.
4. The count is scaled down by what a recent machine-snow hour actually left on the ground (managed depth less natural depth, over the recent hours) against the 3 cm a cold hour makes. The past hours were fitted to the resort's reported depth and many were barely cold enough; the coldest hours ahead make several times more. Unscaled, Blue Mountain's summit grew from 50 cm to 117 cm in a week against a resort report of 66 cm.

Nothing is predicted when the resort made no snow in those 14 days (`none_recently`) or when there were fewer than 12 cold hours to judge by (`too_few_cold_hours`). A resort whose recent record holds no machine snow, from sightings or from base-depth readings, therefore never gets predicted machine snow. Base depth alone is enough: Blue Mountain's base had no sightings, only machine snow added for base-depth readings, and still got a prediction. The saved state is not touched: only the forecast copy holds the predicted snow, so the next refresh starts from observations again.

The result says what was assumed, per point, in [`managed.forecast.snowmaking`](api/result-document.md#forecast). A caller must present these as expected, never as seen.

### Which model point

| The observation carries        | It applies to                                |
| ------------------------------ | -------------------------------------------- |
| `location`: base, mid, summit  | That point, or the nearest one by elevation. |
| `location`: resort, or nothing | Every point, unless `elevationM` is given.   |
| `elevationM` only              | The nearest point.                           |

A webcam sees part of the mountain, so its observation speaks for that point's terrain, not for every run.

## Amendments

Each saved managed state carries a hash of every managed input up to its time: each day's grooming hour and machine-snow hours, chained from the spin-up state.

To reach a day, the chain reuses the newest saved state whose hash matches the inputs as they stand now, and runs forward from there. An amended observation changes the hash from the first day whose inputs it changes, so those days and the ones after run again. For a base-depth reading that can be up to 14 days before it, since that is where its machine snow goes. Nothing is invalidated by hand, and older states stay on disk.

A base-depth correction is saved with the hash of the inputs it was worked out against. If earlier inputs change, it is worked out again; otherwise it is reused, so a refresh with nothing new runs no past managed days at all.

## Storage

Postgres, because observations are small, structured and queried by day. Model data stays in files.

| Table                    | Holds                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `observations`           | Every observation received, append-only. An amendment is a new `revision` of the same `key`; the highest is in force. |
| `observation_batches`    | Each request: its idempotency key, the `through` time it stated, and the answer it got.                               |
| `base_depth_resolutions` | What the model did about one reading at one point: hours added or removed, and the gap left.                          |
| `state_checkpoints`      | Gains `scenario` (natural or managed) and `inputs_hash` for managed states.                                           |

## API

The HTTP reference is in [`docs/api/`](api/): request and response fields, status codes, errors and live examples. This document doesn't repeat it.

| Call                                                                                            | What it does                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| [`POST /v1/resorts/:id/observations`](api/endpoints.md#post-v1resortsidobservations)            | Stores a batch, with a `through` time. Each record comes back `accepted`, `amended` or `unchanged`. `201` new, `200` retry, `409` key reused. |
| [`GET /v1/resorts/:id/observations/latest`](api/endpoints.md#get-v1resortsidobservationslatest) | The newest record per kind, the latest `through` and `lastChangedAt`, so Boxel sends only what is new.                                        |
| [`GET /v1/resorts/:id/observations`](api/endpoints.md#get-v1resortsidobservations)              | Lists what is stored; `revisions=all` includes superseded revisions.                                                                          |
| [`POST /v1/resorts/:id/refresh`](api/endpoints.md#post-v1resortsidrefresh)                      | Gains `scenario`, `groomingDefault` and `snowmakingForecast`.                                                                                 |
| [Result document](api/result-document.md#managed)                                               | A managed result has `scenario: "managed"`, `provenance.observationsThrough` and `managedRulesVersion`, and a `managed` block per point.      |

Metric only, like the rest of the contract: Boxel converts a resort's inches before sending. Boxel decides which status a record has. In particular, only a person or a camera that watched the whole night should send `not_groomed`; a camera that saw nothing sends `unknown`.

On a managed result, each point's `state`, `met` and `profiles` are the managed snowpack. Dry machine-snow layers have `grainTypeCode` 6 and `grainTypePrimary` `MM`; once wetted, SNOWPACK gives them melt-form codes like natural snow, so `managed.technicalSnow`, not the grain code, says machine snow was added. The service still returns raw physical data only: whether a surface is "firm" or a window is "best" stays in Boxel.

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
