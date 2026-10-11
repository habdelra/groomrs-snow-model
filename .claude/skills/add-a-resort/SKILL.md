---
name: add-a-resort
description: Adding or changing a ski resort in groomrs-snow-model — the YAML schema in config/resorts, sourcing and reconciling coordinates/elevations (converted to metres at entry, sources cited), how vertical drop decides 1/2/3 SNOWPACK points, season policy for northern vs southern resorts, choosing the Open-Meteo model with the probe, what a config change does to existing state (configVersion), and verifying with a hindcast. Use whenever adding a resort, editing a resort YAML, or answering why a resort has the points it has.
---

# Adding a resort

## 1. Write `config/resorts/<id>.yaml`

The file name must equal `id`: lowercase, hyphenated, with a country/region suffix, e.g. `vail-co` or `el-colorado-cl`.

```yaml
id: vail-co
name: Vail
location:
  country: US # ISO 3166-1 alpha-2
  region: Colorado
  latitude: 39.639
  longitude: -106.374
  timezone: America/Denver # IANA; Boxel uses it for resort-local display
hemisphere: north # north | south
elevationsM: # METRES, lift-served base and summit
  base: 2475
  summit: 3527
season:
  typicalOpening: '11-14' # MM-DD
  typicalClosing: '04-19'
  spinupDays: 75 # bare-ground start = typical opening − spinupDays
weather:
  provider: open-meteo
  model: ecmwf_ifs025
sources:
  - https://en.wikipedia.org/wiki/Vail_Ski_Resort
```

- **Units**: convert feet to metres at entry (ft × 0.3048) and note the original figures in a comment. Nothing imperial goes into config.
- **Reconcile sources.** Published figures often disagree: Blue Mountain's summit is 1,540 ft in the Wikipedia infobox, 1,407 ft in its body text and in DCSki. Prefer the pair that matches the published vertical drop, and explain the choice in a comment, as `blue-mountain-pa.yaml` does. Wikipedia infoboxes can be plainly wrong; El Colorado's lists a 1,540 m top above a 2,430 m base.
- **Coordinates**: the resort's own coordinates are fine. Each point shares them and differs only in elevation, and Open-Meteo downscales by `elevation`.
- **Season dates** are typical, not this year's. A northern season id is `YYYY/YY` and turns over on 1 July; a southern one is the calendar year.

## 2. Points come from vertical drop

`modelPoints()` in `src/resorts/registry.ts` (snow-carving-model-v3 §28):

| Drop      | Points                                     |
| --------- | ------------------------------------------ |
| < 300 m   | `mid`                                      |
| 300–800 m | `base`, `summit`                           |
| ≥ 800 m   | `base`, `mid` (rounded midpoint), `summit` |

The thresholds are uncalibrated starting values. Point ids become SNOWPACK station ids (`BASE`, `MID`, `SUMMIT`).

## 3. Pick the weather model with the probe

```sh
mise run stack:up
mise run probe:open-meteo <id> -- --models ecmwf_ifs025,gfs_seamless
```

- Check that every required variable is complete over the coming forecast and back through at least `spinupDays` before the typical opening.
- Check that precipitation phase is plausible in mid-winter: a cold mountain shouldn't report mostly rain.
- `ecmwf_ifs025` is the default everywhere; `open-meteo-self-host` explains why. Don't use `best_match`, because it hides which model produced the data.

## 4. Load and verify

- `mise run test`: the registry test fails on schema errors. Update its expected resort list and point counts, and `test/integration/resorts.test.ts`.
- `mise run stack:up` to rebuild, then initialize and refresh a recent winter date, and check that snow depth and layers are plausible:

```sh
curl -s -XPOST localhost:8090/v1/resorts/<id>/seasons/<season>/initialize \
  -H 'content-type: application/json' -d '{"idempotencyKey":"<id>-check","asOf":"<winter date>"}'
```

## Changing an existing resort

Any change to the YAML, or to `config/snowpack/base.ini.tmpl`, changes the resort's `configVersion`. Existing checkpoints belong to the old version, so refresh is `blocked` with `not_initialized` until the season is initialized again. This is deliberate: results are never computed from state built under a different configuration. Mention the re-initialization in the PR.
