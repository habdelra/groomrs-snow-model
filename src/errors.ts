// A job that cannot proceed until something outside it changes (the season
// isn't initialized, the weather archive has a hole). Reported as status
// `blocked` with a machine-readable reason, never retried automatically.
export class BlockedError extends Error {
  readonly reason: string;
  readonly details: unknown;

  constructor(reason: string, message: string, details?: unknown) {
    super(message);
    this.name = 'BlockedError';
    this.reason = reason;
    this.details = details;
  }
}
