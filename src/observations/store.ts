import { createHash, randomUUID } from 'node:crypto';
import type {
  Observation,
  ObservationBatchRequest,
  ObservationKind,
} from '../contract/v1.ts';
import { withClient, withTransaction } from '../db.ts';
import { canonicalJson } from '../jobs/queue.ts';
import type { Resort } from '../resorts/registry.ts';
import { seasonFor } from '../season.ts';

// An observation as stored: the record Boxel sent, plus the revision it
// became and when it arrived.
export interface StoredObservation {
  id: string;
  resortId: string;
  season: string;
  kind: ObservationKind;
  key: string;
  revision: number;
  status: string;
  skiDay: string;
  validFrom: Date;
  validTo: Date;
  source: string;
  payload: Observation;
  observedAt: Date;
  receivedAt: Date;
}

interface Row {
  id: string;
  resort_id: string;
  season: string;
  kind: ObservationKind;
  key: string;
  revision: number;
  status: string;
  ski_day: string;
  valid_from: Date;
  valid_to: Date;
  source: string;
  payload: Observation;
  observed_at: Date;
  received_at: Date;
}

const COLUMNS = `id, resort_id, season, kind, key, revision, status,
  to_char(ski_day, 'YYYY-MM-DD') AS ski_day, valid_from, valid_to, source,
  payload, observed_at, received_at`;

function toStored(r: Row): StoredObservation {
  return {
    id: r.id,
    resortId: r.resort_id,
    season: r.season,
    kind: r.kind,
    key: r.key,
    revision: r.revision,
    status: r.status,
    skiDay: r.ski_day,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    source: r.source,
    payload: r.payload,
    observedAt: r.observed_at,
    receivedAt: r.received_at,
  };
}

export type Outcome = 'accepted' | 'amended' | 'unchanged';

export interface BatchResponse {
  batchId: string;
  resort: string;
  through: string;
  counts: Record<Outcome, number>;
  results: Array<{ key: string; outcome: Outcome; revision: number }>;
  // The earliest time a new or amended record covers. The managed chain
  // re-runs from the last saved state before it on the next refresh.
  earliestAffected: string | null;
}

export class BatchConflict extends Error {
  constructor(key: string) {
    super(
      `idempotency key ${key} was already used for a different batch of observations`,
    );
  }
}

// Stores a batch. A record whose content matches the revision in force is
// left alone; a changed one becomes the next revision. Nothing is updated or
// deleted, and no model runs.
export async function storeBatch(
  resort: Resort,
  request: ObservationBatchRequest,
): Promise<{ response: BatchResponse; created: boolean }> {
  const requestHash = createHash('sha256')
    .update(canonicalJson(request))
    .digest('hex');
  return withTransaction(async (c) => {
    const batchId = randomUUID();
    const inserted = await c.query(
      `INSERT INTO observation_batches (id, resort_id, idempotency_key, request_hash, through, response)
       VALUES ($1, $2, $3, $4, $5, '{}')
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        batchId,
        resort.id,
        request.idempotencyKey,
        requestHash,
        request.through,
      ],
    );
    if (inserted.rowCount === 0) {
      const { rows } = await c.query<{
        resort_id: string;
        request_hash: string;
        response: BatchResponse;
      }>(
        'SELECT resort_id, request_hash, response FROM observation_batches WHERE idempotency_key = $1',
        [request.idempotencyKey],
      );
      const existing = rows[0]!;
      if (
        existing.resort_id !== resort.id ||
        existing.request_hash !== requestHash
      )
        throw new BatchConflict(request.idempotencyKey);
      return { response: existing.response, created: false };
    }

    const counts: Record<Outcome, number> = {
      accepted: 0,
      amended: 0,
      unchanged: 0,
    };
    const results: BatchResponse['results'] = [];
    let earliest: Date | null = null;
    for (const obs of request.observations) {
      const { rows } = await c.query<{ revision: number; payload: unknown }>(
        `SELECT revision, payload FROM observations
         WHERE resort_id = $1 AND key = $2 ORDER BY revision DESC LIMIT 1`,
        [resort.id, obs.key],
      );
      const current = rows[0];
      if (current && canonicalJson(current.payload) === canonicalJson(obs)) {
        counts.unchanged++;
        results.push({
          key: obs.key,
          outcome: 'unchanged',
          revision: current.revision,
        });
        continue;
      }
      const revision = (current?.revision ?? 0) + 1;
      const validFrom = new Date(obs.validFrom);
      const validTo = new Date(obs.validTo ?? obs.validFrom);
      await c.query(
        `INSERT INTO observations
           (id, resort_id, season, kind, key, revision, status, ski_day, valid_from, valid_to,
            source, payload, observed_at, batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          randomUUID(),
          resort.id,
          seasonFor(resort.hemisphere, validFrom),
          obs.kind,
          obs.key,
          revision,
          obs.status,
          obs.skiDay,
          validFrom,
          validTo,
          obs.source,
          JSON.stringify(obs),
          obs.observedAt,
          batchId,
        ],
      );
      const outcome: Outcome = current ? 'amended' : 'accepted';
      counts[outcome]++;
      results.push({ key: obs.key, outcome, revision });
      if (!earliest || validFrom < earliest) earliest = validFrom;
    }
    const response: BatchResponse = {
      batchId,
      resort: resort.id,
      through: new Date(request.through).toISOString(),
      counts,
      results,
      earliestAffected: earliest?.toISOString() ?? null,
    };
    await c.query(
      'UPDATE observation_batches SET response = $2 WHERE id = $1',
      [batchId, JSON.stringify(response)],
    );
    return { response, created: true };
  });
}

// The latest time the caller says it has reported everything up to.
export async function reportedThrough(resortId: string): Promise<Date | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ through: Date | null }>(
      'SELECT max(through) AS through FROM observation_batches WHERE resort_id = $1',
      [resortId],
    );
    return rows[0]?.through ?? null;
  });
}

// When a batch last stored or amended anything. It changes whenever the
// records in force change, so a caller can tell whether a result it holds
// was made from what is stored now.
export async function lastChangedAt(resortId: string): Promise<Date | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<{ at: Date | null }>(
      'SELECT max(received_at) AS at FROM observations WHERE resort_id = $1',
      [resortId],
    );
    return rows[0]?.at ?? null;
  });
}

// The revisions in force (the highest per key), oldest first.
export async function effectiveObservations(
  resortId: string,
  opts: {
    season?: string;
    kind?: ObservationKind;
    from?: Date;
    to?: Date;
    allRevisions?: boolean;
  } = {},
): Promise<StoredObservation[]> {
  return withClient(async (c) => {
    const where = ['resort_id = $1'];
    const params: unknown[] = [resortId];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (opts.season) add('season = ?', opts.season);
    if (opts.kind) add('kind = ?', opts.kind);
    if (opts.from) add('valid_to >= ?', opts.from);
    if (opts.to) add('valid_from <= ?', opts.to);
    const inForce = opts.allRevisions
      ? ''
      : `AND revision = (SELECT max(revision) FROM observations o2
                         WHERE o2.resort_id = o.resort_id AND o2.key = o.key)`;
    const { rows } = await c.query<Row>(
      `SELECT ${COLUMNS} FROM observations o
       WHERE ${where.join(' AND ')} ${inForce}
       ORDER BY valid_from, key, revision`,
      params,
    );
    return rows.map(toStored);
  });
}

// For each kind, the observation in force that covers the latest time, and
// how many keys are stored: what the caller needs to send only what is new.
export async function latestByKind(resortId: string): Promise<{
  latest: Record<ObservationKind, StoredObservation | null>;
  counts: Record<ObservationKind, number>;
}> {
  const all = await effectiveObservations(resortId);
  const latest: Record<ObservationKind, StoredObservation | null> = {
    grooming: null,
    snowmaking: null,
    base_depth: null,
  };
  const counts: Record<ObservationKind, number> = {
    grooming: 0,
    snowmaking: 0,
    base_depth: 0,
  };
  for (const o of all) {
    counts[o.kind]++;
    const cur = latest[o.kind];
    if (!cur || o.validTo >= cur.validTo) latest[o.kind] = o;
  }
  return { latest, counts };
}

export async function hasObservations(
  resortId: string,
  season: string,
): Promise<boolean> {
  return withClient(async (c) => {
    const { rows } = await c.query(
      'SELECT 1 FROM observations WHERE resort_id = $1 AND season = $2 LIMIT 1',
      [resortId, season],
    );
    return rows.length > 0;
  });
}

export function observationView(o: StoredObservation) {
  return {
    ...o.payload,
    revision: o.revision,
    season: o.season,
    receivedAt: o.receivedAt.toISOString(),
  };
}
