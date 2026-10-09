// Collapses concurrent calls for the same key into one. While a call for a key
// is running, later callers get the same promise instead of starting another.
//
// Used against cache stampedes: when a popular link's cache entry expires,
// thousands of requests can miss in the same instant. Without this, each
// would run the same database query; with it, each process runs one.
export class SingleFlight<K, V> {
  private readonly inFlight = new Map<K, Promise<V>>();

  run(key: K, fn: () => Promise<V>): Promise<V> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }
}
