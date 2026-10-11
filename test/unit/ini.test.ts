import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bareGroundSno,
  readIniTemplate,
  renderIni,
} from '../../src/snowpack/config.ts';
import { parseResort } from '../../src/resorts/registry.ts';

test('the ini template renders every placeholder', () => {
  const ini = renderIni(readIniTemplate(), {
    station: 'BASE',
    inputDir: '/data/runs/x/input',
    outputDir: '/data/runs/x/output',
    profileIntervalHours: 3,
  });
  assert.doesNotMatch(ini, /\{\{/);
  assert.match(ini, /STATION1 = BASE/);
  assert.match(ini, /METEOPATH = \/data\/runs\/x\/input/);
  assert.match(ini, /PROF_WRITE = true/);
  assert.match(ini, /PROF_DAYS_BETWEEN = 0\.12500000/);
  assert.match(ini, /ILWR::generator1 = ALLSKY_LW/);
});

test('profiles can be switched off', () => {
  const ini = renderIni(readIniTemplate(), {
    station: 'BASE',
    inputDir: '/i',
    outputDir: '/o',
    profileIntervalHours: null,
  });
  assert.match(ini, /PROF_WRITE = false/);
});

test('an unknown placeholder is an error', () => {
  assert.throws(
    () =>
      renderIni('X = {{NOPE}}', {
        station: 'A',
        inputDir: '/i',
        outputDir: '/o',
        profileIntervalHours: null,
      }),
    /unknown ini placeholder NOPE/,
  );
});

test('the bare-ground snow file has no layers and starts at the spin-up', () => {
  const resort = parseResort(`
id: t
name: T
location: { country: US, region: X, latitude: 40, longitude: -75, timezone: UTC }
hemisphere: north
elevationsM: { base: 100, summit: 500 }
season: { typicalOpening: '12-01', typicalClosing: '03-31', spinupDays: 60 }
weather: { provider: open-meteo, model: ecmwf_ifs025 }
`);
  const sno = bareGroundSno(
    resort,
    resort.points[1]!,
    new Date('2025-10-02T00:00:00Z'),
  );
  assert.match(sno, /station_id {7}= SUMMIT/);
  assert.match(sno, /ProfileDate {6}= 2025-10-02T00:00/);
  assert.match(sno, /nSnowLayerData {3}= 0/);
});
