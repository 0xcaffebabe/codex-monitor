export type KeyedExecutor = <T>(key: string, operation: () => Promise<T>) => Promise<T>;

/** Serializes operations for one key while allowing unrelated keys to make progress. */
export function createKeyedExecutor(): KeyedExecutor {
  const lanes = new Map<string, Promise<void>>();
  return (key, operation) => {
    const job = (lanes.get(key) ?? Promise.resolve()).then(operation);
    const lane = job.then(
      () => {},
      () => {},
    );
    lanes.set(key, lane);
    void lane.then(() => {
      if (lanes.get(key) === lane) lanes.delete(key);
    });
    return job;
  };
}
