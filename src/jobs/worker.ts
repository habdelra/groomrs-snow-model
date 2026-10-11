import type { FastifyBaseLogger } from 'fastify';
import { BlockedError } from '../errors.ts';
import type { SnowModel } from './model.ts';
import { claimNext, finishJob, renewLease } from './queue.ts';

const LEASE_SECONDS = 60;

// Polls Postgres for runnable jobs and runs them one at a time. A job's lease
// is renewed while it runs; if this process dies, the lease lapses and the
// job is claimed again (resuming from the checkpoints it already saved).
export class Worker {
  readonly #model: SnowModel;
  readonly #log: FastifyBaseLogger;
  readonly #pollMs: number;
  #stopped = false;
  #loop: Promise<void> | undefined;
  #wake: (() => void) | undefined;

  constructor(model: SnowModel, log: FastifyBaseLogger, pollMs: number) {
    this.#model = model;
    this.#log = log;
    this.#pollMs = pollMs;
  }

  start(): void {
    this.#loop ??= this.#run();
  }

  // Skip the rest of the current poll interval, e.g. right after a job is
  // created.
  nudge(): void {
    this.#wake?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.nudge();
    await this.#loop;
  }

  async #run(): Promise<void> {
    while (!this.#stopped) {
      let worked = false;
      try {
        worked = await this.#runOne();
      } catch (err) {
        this.#log.error({ err }, 'worker poll failed');
      }
      if (!worked && !this.#stopped) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#pollMs);
          this.#wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        this.#wake = undefined;
      }
    }
  }

  async #runOne(): Promise<boolean> {
    const job = await claimNext(LEASE_SECONDS);
    if (!job) return false;
    const log = this.#log.child({
      jobId: job.id,
      kind: job.kind,
      resort: job.resortId,
    });
    log.info({ attempt: job.attempts }, 'job started');
    const heartbeat = setInterval(
      () => {
        renewLease(job.id, LEASE_SECONDS).catch((err) =>
          log.warn({ err }, 'lease renewal failed'),
        );
      },
      (LEASE_SECONDS * 1000) / 4,
    );
    try {
      const { resultId } = await this.#model.run(job);
      await finishJob(job.id, 'complete', { resultId });
      log.info({ resultId }, 'job complete');
    } catch (err) {
      if (err instanceof BlockedError) {
        await finishJob(job.id, 'blocked', {
          error: {
            reason: err.reason,
            message: err.message,
            details: err.details,
          },
        });
        log.warn({ reason: err.reason }, err.message);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        await finishJob(job.id, 'failed', {
          error: { reason: 'error', message },
        });
        log.error({ err }, 'job failed');
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
