export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

/** System clock backed by the current wall time. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/** Creates a deterministic counter-based id generator for tests and single-process sessions. */
export function createIdGenerator(): IdGenerator {
  let counter = 0;
  return {
    next: (prefix) => `${prefix}_${++counter}`,
  };
}
