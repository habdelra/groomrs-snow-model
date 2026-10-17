# Result document

A completed [refresh job](endpoints.md#post-v1resortsidrefresh) produces one result document. Fetch it with [`GET /v1/results/:id`](endpoints.md#get-v1resultsid) or [`GET /v1/resorts/:id/results/latest`](endpoints.md#get-v1resortsidresultslatest). Its JSON Schema is `resultDocument` in [`GET /v1/schema`](endpoints.md#get-v1schema).

All numbers are metric and name their unit (see [Units](overview.md#units)). Fields in the tables below marked "number \| null" are `null` when the source had no value.

## Shape

```json
{
  "schemaVersion": "groomrs-snow-model/v1",
  "id": "69a02752-d7e8-4eb1-b955-09e54f4c4259",
  "jobId": "05557bb1-a9b7-4971-aea4-438dfb82559d",
  "resort": { "id": "vail-co", "configVersion": "793ded04f3cd" },
  "season": "2025/26",
  "asOf": "2026-02-03T06:00:00.000Z",
  "window": {
    "from": "2026-02-03T00:00:00.000Z",
    "to": "2026-02-05T00:00:00.000Z"
  },
  "generatedAt": "2026-10-11T16:33:13.016Z",
  "scenario": "natural",
  "provenance": {
    "weatherProvider": "open-meteo",
    "weatherModel": "ecmwf_ifs025",
    "weatherRetrievedAt": "2026-10-11T16:25:57.933Z",
    "weatherKind": "archived",
    "snowpackVersion": "3.7.0",
    "serviceVersion": "0.1.0"
  },
  "points": [
    {
      "id": "base",
      "elevationM": 2475,
      "state": { "…": "…" },
      "forcing": ["…"],
      "met": ["…"],
      "profiles": ["…"],
      "files": { "…": "…" }
    }
  ],
  "dataGaps": []
}
```

## Top level

| Field                  | Type          | Description                                                                                            |
| ---------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `schemaVersion`        | string        | Always `groomrs-snow-model/v1` for this contract.                                                      |
| `id`                   | string (UUID) | Result id.                                                                                             |
| `jobId`                | string (UUID) | The refresh job that produced it.                                                                      |
| `resort.id`            | string        | Resort id.                                                                                             |
| `resort.configVersion` | string        | The resort [`configVersion`](overview.md#resorts-and-model-points) the result was computed with.       |
| `season`               | string        | Season, e.g. `2025/26` or `2026`.                                                                      |
| `asOf`                 | string        | The refresh's resolved `asOf`, unrounded.                                                              |
| `window.from`          | string        | Start of the forecast window: midnight UTC of `asOf`'s day. Also the time of the starting state.       |
| `window.to`            | string        | End of the window, inclusive: `window.from` + `horizonHours`.                                          |
| `generatedAt`          | string        | When the document was written.                                                                         |
| `scenario`             | string        | Always `natural` in Stage 1: natural snow, no snowmaking or grooming. Other values may be added later. |
| `provenance`           | object        | Where the data came from. See below.                                                                   |
| `points`               | array         | One entry per resort model point, in the resort's point order. See [Point](#point).                    |
| `dataGaps`             | array         | Weather variables with missing hours. See [Data gaps](#data-gaps).                                     |

### `provenance`

| Field                | Type   | Description                                                                                                                                   |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `weatherProvider`    | string | Always `open-meteo`.                                                                                                                          |
| `weatherModel`       | string | Open-Meteo model, e.g. `ecmwf_ifs025`.                                                                                                        |
| `weatherRetrievedAt` | string | The oldest retrieval time of the weather used across all points.                                                                              |
| `weatherKind`        | string | `archived` if the whole window had passed at `weatherRetrievedAt` (a hindcast), `forecast` if all of it was in the future, `mixed` otherwise. |
| `snowpackVersion`    | string | SNOWPACK version used.                                                                                                                        |
| `serviceVersion`     | string | Version of this service.                                                                                                                      |

## Point

| Field        | Type   | Description                                                             |
| ------------ | ------ | ----------------------------------------------------------------------- |
| `id`         | string | `base`, `mid` or `summit`.                                              |
| `elevationM` | number | Elevation of the modelled column, m.                                    |
| `state`      | object | The saved snowpack state the forecast started from.                     |
| `forcing`    | array  | Hourly weather fed to SNOWPACK. See [Forcing](#forcing-hourly-weather). |
| `met`        | array  | SNOWPACK's hourly output. See [Met](#met-hourly-snowpack-series).       |
| `profiles`   | array  | Layer profiles every 3 hours. See [Profiles](#profiles).                |
| `files`      | object | The forecast run's id and native files. See [`files`](#files).          |

### `state`

| Field                 | Type          | Description                                                                                           |
| --------------------- | ------------- | ----------------------------------------------------------------------------------------------------- |
| `lineageId`           | string (UUID) | The initialize job this state descends from. See [Re-initializing](jobs.md#re-initializing-a-season). |
| `checkpointValidTime` | string        | When the state is valid. Equal to `window.from`.                                                      |
| `snowDepthCm`         | number        | Modelled snow depth at the checkpoint, cm.                                                            |

### Time series alignment

`forcing` and `met` hold one entry per hour from `window.from` to `window.to` **inclusive**, so a 48-hour window has 49 entries. Entries are in time order, and entries with the same index have the same `time`.

### Forcing (hourly weather)

The hourly weather from Open-Meteo, downscaled to the point's elevation. It has the same fields as [`GET /v1/resorts/:id/weather`](endpoints.md#get-v1resortsidweather) hours.

| Field                 | Type           | Unit / meaning                                      |
| --------------------- | -------------- | --------------------------------------------------- |
| `time`                | string         | Start of the hour, UTC.                             |
| `airTempC`            | number \| null | Air temperature at 2 m, °C.                         |
| `relativeHumidityPct` | number \| null | Relative humidity at 2 m, %.                        |
| `windSpeedMs`         | number \| null | Wind speed at 10 m, m/s.                            |
| `windDirectionDeg`    | number \| null | Wind direction at 10 m, degrees from north.         |
| `shortwaveWm2`        | number \| null | Incoming shortwave radiation, W/m².                 |
| `precipitationMm`     | number \| null | Total precipitation in the hour, mm.                |
| `rainMm`              | number \| null | Rain in the hour, mm.                               |
| `snowfallCm`          | number \| null | New snow in the hour as reported by Open-Meteo, cm. |
| `cloudCoverPct`       | number \| null | Total cloud cover, %.                               |
| `surfacePressureHpa`  | number \| null | Surface pressure, hPa.                              |

`snowfallCm` is Open-Meteo's own estimate. SNOWPACK decides the precipitation phase itself, so for modelled new snow use `met[].newSnow*Cm`.

### Met (hourly SNOWPACK series)

SNOWPACK's hourly output for the point's snow column.

| Field                   | Type           | Unit / meaning                                                          |
| ----------------------- | -------------- | ----------------------------------------------------------------------- |
| `time`                  | string         | UTC.                                                                    |
| `snowDepthCm`           | number \| null | Modelled snow depth, cm.                                                |
| `sweMm`                 | number \| null | Snow water equivalent, mm.                                              |
| `surfaceTempC`          | number \| null | Modelled snow (or ground) surface temperature, °C.                      |
| `airTempC`              | number \| null | Air temperature as SNOWPACK used it, °C.                                |
| `relativeHumidityPct`   | number \| null | Relative humidity as used, %.                                           |
| `windSpeedMs`           | number \| null | Wind speed as used, m/s.                                                |
| `incomingShortwaveWm2`  | number \| null | Incoming shortwave radiation, W/m².                                     |
| `reflectedShortwaveWm2` | number \| null | Reflected shortwave radiation, W/m².                                    |
| `incomingLongwaveWm2`   | number \| null | Incoming longwave radiation, W/m². Generated by MeteoIO (not measured). |
| `outgoingLongwaveWm2`   | number \| null | Outgoing longwave radiation, W/m².                                      |
| `sensibleHeatWm2`       | number \| null | Sensible heat flux, W/m².                                               |
| `latentHeatWm2`         | number \| null | Latent heat flux, W/m².                                                 |
| `groundHeatWm2`         | number \| null | Ground heat flux, W/m².                                                 |
| `rainEnergyWm2`         | number \| null | Energy supplied by rain, W/m².                                          |
| `albedoFraction`        | number \| null | Surface albedo, 0–1.                                                    |
| `liquidWaterMm`         | number \| null | Total liquid water held in the snowpack, mm.                            |
| `snowfallRateMmPerH`    | number \| null | Snowfall rate, mm/h water equivalent.                                   |
| `rainRateMmPerH`        | number \| null | Rain rate, mm/h.                                                        |
| `runoffMm`              | number \| null | Runoff from the bottom of the snowpack, mm.                             |
| `sublimationMm`         | number \| null | Sublimation, mm.                                                        |
| `evaporationMm`         | number \| null | Evaporation, mm.                                                        |
| `newSnow3hCm`           | number \| null | Modelled new snow over the past 3 hours, cm.                            |
| `newSnow24hCm`          | number \| null | Modelled new snow over the past 24 hours, cm.                           |
| `newSnow72hCm`          | number \| null | Modelled new snow over the past 72 hours, cm.                           |
| `precipitation24hMm`    | number \| null | Precipitation over the past 24 hours, mm.                               |
| `skierPenetrationCm`    | number \| null | Modelled ski penetration depth, cm.                                     |
| `surfaceHoarSizeMm`     | number \| null | Surface hoar size, mm.                                                  |
| `coldContentMjM2`       | number \| null | Cold content of the snowpack, MJ/m².                                    |

### Profiles

Snapshots of the full layer stack every **3 hours** from `window.from` to `window.to` inclusive, so a 48-hour window has 17 profiles.

| Field         | Type   | Description                                                  |
| ------------- | ------ | ------------------------------------------------------------ |
| `time`        | string | UTC.                                                         |
| `snowDepthCm` | number | Total snow depth at that time, cm.                           |
| `layers`      | array  | Snow layers, **surface first**. Empty when there is no snow. |

If you requested `profileDepthCm`, `layers` only holds layers whose top is within that depth of the surface. `snowDepthCm` still gives the full depth.

#### Layer

Each layer is one SNOWPACK element. Layers are often well under 1 cm thick near the surface.

```json
{
  "topHeightCm": 30.27,
  "thicknessCm": 0.55,
  "depthCm": 0,
  "densityKgM3": 57.4,
  "temperatureC": -5.55,
  "liquidWaterPct": 0,
  "ageDays": 2.38,
  "grainSizeMm": 1.54,
  "bondSizeMm": 0.12,
  "dendricity": 0.2,
  "sphericity": 0.18,
  "coordinationNumber": 1,
  "grainTypeCode": 240,
  "grainTypePrimary": "DF",
  "grainTypeSecondary": "FC",
  "handHardnessIndex": 1,
  "iceVolumePct": 6,
  "airVolumePct": 94
}
```

| Field                | Type           | Unit / meaning                                                                  |
| -------------------- | -------------- | ------------------------------------------------------------------------------- |
| `topHeightCm`        | number         | Height of the layer's top above the ground, cm.                                 |
| `thicknessCm`        | number         | Layer thickness, cm.                                                            |
| `depthCm`            | number         | Depth of the layer's top below the snow surface, cm. `0` for the surface layer. |
| `densityKgM3`        | number \| null | Density, kg/m³.                                                                 |
| `temperatureC`       | number \| null | Temperature, °C.                                                                |
| `liquidWaterPct`     | number \| null | Liquid water content, % by volume.                                              |
| `ageDays`            | number \| null | Age of the layer's snow, days.                                                  |
| `grainSizeMm`        | number \| null | Grain size, mm.                                                                 |
| `bondSizeMm`         | number \| null | Bond size, mm.                                                                  |
| `dendricity`         | number \| null | Dendricity, 0–1 (1 = fresh, branched crystals).                                 |
| `sphericity`         | number \| null | Sphericity, 0–1 (1 = rounded).                                                  |
| `coordinationNumber` | number \| null | Bonds per grain.                                                                |
| `grainTypeCode`      | number \| null | SNOWPACK's Swiss three-digit grain code F1F2F3 (primary, secondary, marker).    |
| `grainTypePrimary`   | string \| null | IACS class of the primary grain type (F1). See the table below.                 |
| `grainTypeSecondary` | string \| null | IACS class of the secondary grain type (F2).                                    |
| `handHardnessIndex`  | number \| null | Hand hardness: 1 fist, 2 four fingers, 3 one finger, 4 pencil, 5 knife, 6 ice.  |
| `iceVolumePct`       | number \| null | Ice volume fraction, %.                                                         |
| `airVolumePct`       | number \| null | Air volume fraction, %.                                                         |

Grain type classes ([Fierz et al. 2009](https://unesdoc.unesco.org/ark:/48223/pf0000186462), The International Classification for Seasonal Snow on the Ground):

| Code digit | IACS class | Meaning                    |
| ---------- | ---------- | -------------------------- |
| 1          | `PP`       | Precipitation particles    |
| 2          | `DF`       | Decomposing and fragmented |
| 3          | `RG`       | Rounded grains             |
| 4          | `FC`       | Faceted crystals           |
| 5          | `DH`       | Depth hoar                 |
| 6          | `SH`       | Surface hoar               |
| 7          | `MF`       | Melt forms                 |
| 8          | `IF`       | Ice formations             |
| 9          | `PPgp`     | Graupel                    |

For example, `grainTypeCode` `240` is primary `DF`, secondary `FC`, marker `0`.

### `files`

| Field   | Type          | Description                                                                                                              |
| ------- | ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `runId` | string (UUID) | The point's forecast run.                                                                                                |
| `names` | string[]      | Paths of its native files, downloadable from [`GET /v1/runs/:runId/files/*path`](endpoints.md#get-v1runsrunidfilespath). |

## Data gaps

`dataGaps` lists, per point, every forcing variable that had at least one missing (`null`) hour in the window. It is empty when the weather was complete.

```json
[
  {
    "pointId": "summit",
    "variable": "cloudCoverPct",
    "missingHours": 3,
    "totalHours": 49
  }
]
```

| Field          | Type    | Description                                     |
| -------------- | ------- | ----------------------------------------------- |
| `pointId`      | string  | Point the gap is at.                            |
| `variable`     | string  | Name of the `forcing` field with missing hours. |
| `missingHours` | integer | Hours with no value.                            |
| `totalHours`   | integer | Hours in the window.                            |

Small gaps are tolerated: SNOWPACK's MeteoIO fills them. If more than 10% of hours are missing for air temperature, humidity, wind speed, shortwave radiation or precipitation, the job is `blocked` with `weather_coverage` instead of producing a result.
