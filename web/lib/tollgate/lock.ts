/**
 * LockStore — pluggable durable lock for in-flight escrows.
 *
 * The reviewer's call: an in-memory Set in wrapTool only protects against
 * parallel handlers within ONE process. A multi-instance deployment, a
 * serverless cold-start, a load balancer, or a process restart all defeat it.
 *
 * Real production deployments must back this with a durable store. The
 * default `MemoryLockStore` keeps the existing behavior (good enough for
 * single-process demos and hackathons). For production:
 *
 *   - RedisLockStore: SETNX / SET NX EX-style atomic acquire with a TTL.
 *   - PostgresLockStore: INSERT INTO escrow_locks (key) ON CONFLICT DO NOTHING
 *     — atomic by virtue of the unique constraint, with a TTL cron.
 *   - Cluster-aware bespoke store: any K/V with atomic put-if-absent semantics.
 *
 * The `release` step must run even on handler error (the wrapTool calls it in
 * a finally block). TTL is the safety net for crashed processes that never
 * release — the on-chain `refund_timeout` deadline is the deeper backstop.
 */

export interface LockStore {
  /**
   * Atomically claim a lock for `key` with a TTL of `ttlMs` milliseconds.
   * Returns true if the lock was acquired, false if it was already held.
   *
   * Implementations MUST be atomic — a concurrent caller in another process
   * must see exactly one `true` return for the same key+TTL window.
   */
  acquire(key: string, ttlMs: number): Promise<boolean>;

  /** Release the lock. Idempotent — calling twice or releasing an unheld lock is a no-op. */
  release(key: string): Promise<void>;
}

/**
 * Default in-memory lock store. Good enough for:
 *   - single-process demos
 *   - hackathon submissions
 *   - dev/test
 *
 * NOT good enough for: anything horizontally scaled, serverless, or
 * load-balanced. Swap in a RedisLockStore (or similar) for production.
 */
export class MemoryLockStore implements LockStore {
  private locks = new Map<string, NodeJS.Timeout>();

  async acquire(key: string, ttlMs: number): Promise<boolean> {
    if (this.locks.has(key)) return false;
    const timer = setTimeout(() => this.locks.delete(key), ttlMs);
    // unref so a stuck lock doesn't keep the process alive
    if (typeof timer.unref === "function") timer.unref();
    this.locks.set(key, timer);
    return true;
  }

  async release(key: string): Promise<void> {
    const t = this.locks.get(key);
    if (t) {
      clearTimeout(t);
      this.locks.delete(key);
    }
  }
}
