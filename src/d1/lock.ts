/**
 * 执行锁：替代 DO 版的 serialize()。
 *
 * DO 版用内存 promise 链（单实例常驻才有效）；D1 版没有常驻实例，
 * 用 locks 表 + 条件 UPSERT 做租约锁，抢不到直接返回不执行。
 */
export interface ExecLock {
  withLock<T>(name: string, fn: () => Promise<T>, ttlMs?: number): Promise<{ locked: true; result: T } | { locked: false }>;
}

/** 内存锁：DO 版用（复用旧 serialize 的 promise 链语义，永远能排上队）。 */
export class MemoryLock implements ExecLock {
  private queue: Promise<unknown> = Promise.resolve();

  async withLock<T>(name: string, fn: () => Promise<T>): Promise<{ locked: true; result: T } | { locked: false }> {
    void name;
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return { locked: true, result: await run };
  }
}

/** D1 租约锁：抢到锁才能执行，抢不到返回 locked: false，租约过期自动失效。 */
export class D1Lock implements ExecLock {
  constructor(private readonly db: D1Database) {}

  /** 抢锁。成功返回 owner（UUID），失败返回 null。ttlMs 默认 10 分钟。 */
  async acquire(name: string, ttlMs = 10 * 60_000): Promise<string | null> {
    const owner = crypto.randomUUID();
    const now = Date.now();
    const result = await this.db
      .prepare(
        `INSERT INTO locks (name, owner, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE
           SET owner = excluded.owner, expires_at = excluded.expires_at
           WHERE locks.expires_at <= ?`,
      )
      .bind(name, owner, now + ttlMs, now)
      .run();
    // changes 为 1 = 抢到（新插或过期续租），0 = 有人持有且未过期
    return result.meta.changes === 1 ? owner : null;
  }

  /** 释放锁（只删自己持有的那把）。 */
  async release(name: string, owner: string): Promise<void> {
    await this.db.prepare("DELETE FROM locks WHERE name = ? AND owner = ?").bind(name, owner).run();
  }

  /** 续租（tick 每跑完一个任务调一次，防长任务跑一半丢锁）。失败返回 false。 */
  async renew(name: string, owner: string, ttlMs = 10 * 60_000): Promise<boolean> {
    const result = await this.db
      .prepare("UPDATE locks SET expires_at = ? WHERE name = ? AND owner = ?")
      .bind(Date.now() + ttlMs, name, owner)
      .run();
    return result.meta.changes === 1;
  }

  async withLock<T>(name: string, fn: () => Promise<T>, ttlMs?: number): Promise<{ locked: true; result: T } | { locked: false }> {
    const owner = await this.acquire(name, ttlMs);
    if (!owner) return { locked: false };
    try {
      return { locked: true, result: await fn() };
    } finally {
      await this.release(name, owner).catch(() => undefined);
    }
  }
}
