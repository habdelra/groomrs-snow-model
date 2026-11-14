import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Observations Boxel sends about what a resort did to its snow, and what the
// managed-snow chain made of them. See docs/observations.md.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // One POST of observations. The idempotency key makes a retried request
  // return the answer it already got instead of storing rows twice.
  pgm.createTable('observation_batches', {
    id: { type: 'uuid', primaryKey: true },
    resort_id: { type: 'text', notNull: true },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    // Hash of the request body, to tell a retry from a reused key.
    request_hash: { type: 'text', notNull: true },
    // The caller's statement that everything observed up to this time has
    // been sent: what tells "nothing was sent" from "nothing was observed".
    through: { type: 'timestamptz', notNull: true },
    response: { type: 'jsonb', notNull: true },
    received_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('observation_batches', ['resort_id', 'received_at']);

  // Every observation ever received, append-only. An amendment is a new
  // revision of the same key; the highest revision is the one in force and
  // earlier ones stay, so a past result can be traced to what it used.
  pgm.createTable('observations', {
    id: { type: 'uuid', primaryKey: true },
    resort_id: { type: 'text', notNull: true },
    season: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true },
    // The record's identity in Boxel, e.g. grooming/vail-eagles-nest/2026-02-16.
    key: { type: 'text', notNull: true },
    revision: { type: 'integer', notNull: true },
    status: { type: 'text', notNull: true },
    ski_day: { type: 'date', notNull: true },
    // The period the observation covers. A point in time has both equal.
    valid_from: { type: 'timestamptz', notNull: true },
    valid_to: { type: 'timestamptz', notNull: true },
    source: { type: 'text', notNull: true },
    // The record exactly as received (after validation).
    payload: { type: 'jsonb', notNull: true },
    observed_at: { type: 'timestamptz', notNull: true },
    received_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    batch_id: {
      type: 'uuid',
      notNull: true,
      references: 'observation_batches',
    },
  });
  pgm.addConstraint('observations', 'observations_kind_check', {
    check: "kind IN ('grooming', 'snowmaking', 'base_depth')",
  });
  pgm.addConstraint('observations', 'observations_key_revision_unique', {
    unique: ['resort_id', 'key', 'revision'],
  });
  pgm.createIndex('observations', [
    'resort_id',
    'season',
    'kind',
    'valid_from',
  ]);

  // What the model did about one base-depth reading at one point: the
  // machine-snow hours it added or removed to close a share of the gap, and
  // the gap it left. `basis_hash` identifies the inputs the answer was worked
  // out against; when earlier inputs change, the row no longer applies and a
  // new one is worked out.
  pgm.createTable('base_depth_resolutions', {
    id: { type: 'uuid', primaryKey: true },
    lineage_id: { type: 'uuid', notNull: true, references: 'jobs' },
    resort_id: { type: 'text', notNull: true },
    point_id: { type: 'text', notNull: true },
    observation_id: { type: 'uuid', notNull: true, references: 'observations' },
    basis_hash: { type: 'text', notNull: true },
    resolution: { type: 'jsonb', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint('base_depth_resolutions', 'base_depth_resolutions_unique', {
    unique: ['lineage_id', 'point_id', 'observation_id', 'basis_hash'],
  });

  // A saved state belongs to the natural chain (weather only) or the managed
  // chain (weather plus grooming and machine snow). A managed state records
  // a hash of every managed input up to its valid time, so a state built
  // from inputs that have since been amended is recognised and not reused.
  pgm.addColumns('state_checkpoints', {
    scenario: { type: 'text', notNull: true, default: 'natural' },
    inputs_hash: { type: 'text' },
  });
  pgm.addConstraint('state_checkpoints', 'state_checkpoints_scenario_check', {
    check: "scenario IN ('natural', 'managed')",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('state_checkpoints', 'state_checkpoints_scenario_check');
  pgm.dropColumns('state_checkpoints', ['scenario', 'inputs_hash']);
  pgm.dropTable('base_depth_resolutions');
  pgm.dropTable('observations');
  pgm.dropTable('observation_batches');
}
