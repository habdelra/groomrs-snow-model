import type { ColumnDefinitions, MigrationBuilder } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Metadata about model work. The model data itself (weather responses, SMET
// forcing, SNOWPACK .sno/.met/.pro files) lives on disk under DATA_DIR in the
// tools' native formats; these tables point at it.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // One requested unit of work: a seasonal spin-up or a refresh. A job is
  // keyed by the caller's idempotency key, so a retried request finds the job
  // it already created instead of starting a second one.
  pgm.createTable('jobs', {
    id: { type: 'uuid', primaryKey: true },
    kind: { type: 'text', notNull: true },
    resort_id: { type: 'text', notNull: true },
    season: { type: 'text', notNull: true },
    idempotency_key: { type: 'text', notNull: true, unique: true },
    request: { type: 'jsonb', notNull: true },
    status: { type: 'text', notNull: true, default: 'queued' },
    progress: { type: 'jsonb', notNull: true, default: '{}' },
    error: { type: 'jsonb' },
    result_id: { type: 'uuid' },
    attempts: { type: 'integer', notNull: true, default: 0 },
    // A running job holds a lease that it renews as it makes progress. A job
    // whose lease has lapsed (its worker died) is claimable again.
    lease_expires_at: { type: 'timestamptz' },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
    started_at: { type: 'timestamptz' },
    finished_at: { type: 'timestamptz' },
  });
  pgm.addConstraint('jobs', 'jobs_kind_check', {
    check: "kind IN ('initialize', 'refresh')",
  });
  pgm.addConstraint('jobs', 'jobs_status_check', {
    check: "status IN ('queued', 'running', 'blocked', 'complete', 'failed')",
  });
  pgm.createIndex('jobs', ['status', 'created_at']);

  // One SNOWPACK execution for one model point. Its run directory holds the
  // exact inputs and outputs.
  pgm.createTable('model_runs', {
    id: { type: 'uuid', primaryKey: true },
    job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs',
      onDelete: 'CASCADE',
    },
    resort_id: { type: 'text', notNull: true },
    point_id: { type: 'text', notNull: true },
    season: { type: 'text', notNull: true },
    kind: { type: 'text', notNull: true },
    valid_from: { type: 'timestamptz', notNull: true },
    valid_to: { type: 'timestamptz', notNull: true },
    input_checkpoint_id: { type: 'uuid' },
    run_dir: { type: 'text', notNull: true },
    snowpack_version: { type: 'text', notNull: true },
    resort_config_version: { type: 'text', notNull: true },
    weather_provider: { type: 'text', notNull: true },
    weather_model: { type: 'text', notNull: true },
    weather_retrieved_at: { type: 'timestamptz', notNull: true },
    duration_ms: { type: 'integer', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.addConstraint('model_runs', 'model_runs_kind_check', {
    check: "kind IN ('spinup', 'advance', 'forecast')",
  });
  pgm.createIndex('model_runs', ['job_id']);

  // Saved snowpack state for a point and season at a valid time, produced by
  // a past-weather run. Forecast runs start from a copy and never write one.
  // A lineage is the chain of states grown from one seasonal spin-up (its id
  // is the initialize job's); re-initializing starts a new lineage rather
  // than mixing states from different spin-ups.
  pgm.createTable('state_checkpoints', {
    id: { type: 'uuid', primaryKey: true },
    lineage_id: { type: 'uuid', notNull: true, references: 'jobs' },
    resort_id: { type: 'text', notNull: true },
    point_id: { type: 'text', notNull: true },
    season: { type: 'text', notNull: true },
    valid_time: { type: 'timestamptz', notNull: true },
    sno_path: { type: 'text', notNull: true },
    produced_by_run_id: {
      type: 'uuid',
      notNull: true,
      references: 'model_runs',
    },
    resort_config_version: { type: 'text', notNull: true },
    snow_depth_cm: { type: 'double precision', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('state_checkpoints', [
    'lineage_id',
    'point_id',
    'valid_time',
  ]);

  // A published result document for a refresh job.
  pgm.createTable('results', {
    id: { type: 'uuid', primaryKey: true },
    job_id: {
      type: 'uuid',
      notNull: true,
      references: 'jobs',
      onDelete: 'CASCADE',
    },
    resort_id: { type: 'text', notNull: true },
    season: { type: 'text', notNull: true },
    as_of: { type: 'timestamptz', notNull: true },
    document_path: { type: 'text', notNull: true },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('now()'),
    },
  });
  pgm.createIndex('results', ['resort_id', 'created_at']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('results');
  pgm.dropTable('state_checkpoints');
  pgm.dropTable('model_runs');
  pgm.dropTable('jobs');
}
