/** Where groundwork reads the current time from. Inject a fake one in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
