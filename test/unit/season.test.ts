import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isValidSeason,
  seasonFor,
  seasonOpening,
  spinupStart,
  startOfUtcDay,
} from '../../src/season.ts';

const policy = {
  typicalOpening: '11-14',
  typicalClosing: '04-19',
  spinupDays: 75,
};

test('northern seasons cross the year boundary and turn over on 1 July', () => {
  assert.equal(seasonFor('north', new Date('2026-02-01T00:00:00Z')), '2025/26');
  assert.equal(seasonFor('north', new Date('2026-06-30T23:59:59Z')), '2025/26');
  assert.equal(seasonFor('north', new Date('2026-07-01T00:00:00Z')), '2026/27');
  assert.equal(seasonFor('north', new Date('2099-12-01T00:00:00Z')), '2099/00');
});

test('southern seasons are calendar years', () => {
  assert.equal(seasonFor('south', new Date('2026-10-11T00:00:00Z')), '2026');
  assert.equal(seasonFor('south', new Date('2026-01-01T00:00:00Z')), '2026');
});

test('season ids are validated per hemisphere', () => {
  assert.ok(isValidSeason('north', '2025/26'));
  assert.ok(!isValidSeason('north', '2025/27'));
  assert.ok(!isValidSeason('north', '2026'));
  assert.ok(isValidSeason('south', '2026'));
  assert.ok(!isValidSeason('south', '2025/26'));
});

test('spin-up starts spinupDays before the typical opening', () => {
  assert.equal(
    seasonOpening('north', '2025/26', policy).toISOString(),
    '2025-11-14T00:00:00.000Z',
  );
  assert.equal(
    spinupStart('north', '2025/26', policy).toISOString(),
    '2025-08-31T00:00:00.000Z',
  );
  // A northern resort opening in January opens in the season's second year.
  assert.equal(
    seasonOpening('north', '2025/26', {
      ...policy,
      typicalOpening: '01-05',
    }).toISOString(),
    '2026-01-05T00:00:00.000Z',
  );
  assert.equal(
    spinupStart('south', '2026', {
      ...policy,
      typicalOpening: '06-20',
    }).toISOString(),
    '2026-04-06T00:00:00.000Z',
  );
});

test('startOfUtcDay truncates to midnight UTC', () => {
  assert.equal(
    startOfUtcDay(new Date('2026-02-01T23:59:00-05:00')).toISOString(),
    '2026-02-02T00:00:00.000Z',
  );
});
