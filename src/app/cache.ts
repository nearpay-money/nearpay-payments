/** A small in-process TTL cache with in-flight de-duplication (rails reads, chain profiles, minimums). */
export interface TtlCache<T> {
  get(key: string, load: () => Promise<T>): Promise<T>;
  clear(): void;
}

export function ttlCache<T>(ttlMs: number, now: () => number = Date.now, max = 10_000): TtlCache<T> {
  const values = new Map<string, { v: T; until: number }>();
  const pending = new Map<string, Promise<T>>();
  return {
    async get(key, load) {
      const hit = values.get(key);
      if (hit && hit.until > now()) return hit.v;
      const inflight = pending.get(key);
      if (inflight) return inflight;
      const p = load()
        .then((v) => {
          values.set(key, { v, until: now() + ttlMs });
          if (values.size > max) values.delete(values.keys().next().value as string);
          return v;
        })
        .finally(() => pending.delete(key));
      pending.set(key, p);
      return p;
    },
    clear() {
      values.clear();
    },
  };
}
