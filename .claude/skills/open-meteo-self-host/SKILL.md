---
name: open-meteo-self-host
description: Running and using the self-hosted Open-Meteo container this service reads weather from — Compose/volume setup and its permission trap, the preallocated cache, which models have which variables over which history windows (measured), why ecmwf_ifs025 is the default, the per-month response cache in DATA_DIR, forecast reach, and attribution. Use when touching src/weather/open-meteo.ts, changing a resort's weather model, debugging missing or implausible weather, or upgrading the Open-Meteo image.
---

# Self-hosted Open-Meteo

`ghcr.io/open-meteo/open-meteo` serves the same `/v1/forecast` API as `api.open-meteo.com`. With `REMOTE_DATA_DIRECTORY=https://openmeteo.s3.amazonaws.com/data/` it reads Open-Meteo's public open-data bucket on demand, so no data is synced up front. The first query for a region takes a few seconds; repeats are fast.

## Container setup (docker-compose.yml)

- **`CACHE_SIZE` is preallocated in full on disk** (`du` shows 8 GB for `CACHE_SIZE=8GB` immediately). The default here is `4GB`, and CI uses `2GB` (`OPEN_METEO_CACHE_SIZE`). Caching it between CI runs is pointless.
- **Use a named volume, not a bind mount**, for `/app/data`. The image runs as uid/gid 999 `openmeteo`, and `/app` is mode `0750`. A bind-mounted host directory isn't writable by uid 999, and running as the host uid can't traverse `/app`. Both crash at startup with `cannotCreateFile … ./data//cache.bin … Permission denied` (or `cannotOpenFile ./data/`). A named volume inherits the image's ownership.
- The service reaches it at `http://open-meteo:8080`; the host reaches it at `127.0.0.1:8080`.
- Needs x86-64 with AVX2 and about 8 GB of RAM. GitHub's `ubuntu-latest` runners qualify.

## Requests we make

One request per point per calendar month (`src/weather/open-meteo.ts`):

```text
/v1/forecast?latitude&longitude&elevation=<point m>&models=<model>
  &hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,
          shortwave_radiation,precipitation,rain,snowfall,cloud_cover,surface_pressure
  &wind_speed_unit=ms&timezone=UTC&start_date=YYYY-MM-01&end_date=<month end or reach>
```

- `elevation` makes Open-Meteo downscale temperature to the point (lapse rate), so the summit really is colder than the base at the same grid cell.
- The same `/v1/forecast` endpoint serves history via `start_date`/`end_date`. The self-host has no separate historical-forecast host.
- **Cache**: `DATA_DIR/weather/open-meteo/<model>/<resort>/<point>/<YYYY-MM>.<hash>.json`. The hash covers lat, lon, elevation and the variable list. A month is "archived" (kept forever) once it ended more than 3 days ago. The current and future months are refetched after a 60-minute TTL.
- **Forecast reach**: requests stop at today + 14 days. `hourly()` refuses windows beyond that.
- The forecast reach, the weather endpoint's window limit, the forcing fields and the `weather_coverage` threshold are all documented for clients in `docs/api/`. Update them there when they change (see the `api-docs` skill).

## Measured coverage (Oct 2026, `mise run probe:open-meteo`)

| Model             | History                                | rain / snowfall           | Notes                                                                                                                                                                               |
| ----------------- | -------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecmwf_ifs025`    | ≥ Dec 2024, all variables except below | **null before ~Nov 2025** | Default for all resorts. Plausible phase in the Rockies: Vail base, Nov 2025–mid Feb 2026, 134 mm precip, 86 cm snow, 3 mm rain.                                                    |
| `gfs_seamless`    | ≥ Dec 2024                             | present                   | For US points its archive returned exactly the HRRR series. At Vail base it gave 85 mm precip, 22 cm snow and **53 mm rain** in mid-winter, which is implausible, so it isn't used. |
| `best_match`      | —                                      | —                         | For US points it returned the same series as `gfs_seamless`. Avoid it, because it hides which model produced the data.                                                              |
| `ncep_hrrr_conus` | —                                      | —                         | Identical to `gfs_seamless` in the archive.                                                                                                                                         |

Consequences:

- Windows before about November 2025 have ECMWF rain/snowfall as null. Our `PSUM_PH` is then nodata, and MeteoIO's `PRECSPLITTING` (a 274.35 K threshold) decides the phase. Precipitation totals are still present.
- `surface_pressure` can be null; it isn't a required forcing.
- Re-run the probe after any image upgrade (the `.om` format changed in 2025) and before changing a resort's model. Record what you find here.

## Required vs optional

`runPoint` blocks a run (`weather_coverage`) when more than 10% of any required variable is missing over the window. The required variables are air temperature, RH, wind speed, shortwave and precipitation. Shorter gaps are bridged by MeteoIO's resampling (`WINDOW_SIZE = 86400`). Every remaining gap is reported in the result's `dataGaps`.

## Attribution

Open-Meteo data is CC BY 4.0; whatever shows it must attribute Open-Meteo. The server is AGPL-3.0, and we run it unmodified in its own container.
