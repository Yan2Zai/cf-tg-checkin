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

  /**
   * 抢锁执行：抢到才跑，抢不到直接返回 locked: false。
   * 执行期间每 ttl/3 续租一次（心跳），活着的执行不丢锁；执行一旦死掉
   * （进程回收、Worker 驱逐），心跳停了，租约最多 ttl 后过期，下一轮自动接管，
   * 不用再手动删锁。ttl 默认 3 分钟：死锁 3 分钟内可接管，活 tick 每 1 分钟续租一次。
   */
  async withLock<T>(name: string, fn: () => Promise<T>, ttlMs = 3 * 60_000): Promise<{ locked: true; result: T } | { locked: false }> {
    const owner = await this.acquire(name, ttlMs);
    if (!owner) return { locked: false };
    const timer = setInterval(() => {
      void this.renew(name, owner, ttlMs).catch(() => undefined);
    }, Math.max(10, Math.floor(ttlMs / 3)));
    // 测试进程里心跳不能拖住退出；workerd 下没有 unref，守卫一下
    (timer as unknown as { unref?: () => void }).unref?.();
    try {
      return { locked: true, result: await fn() };
    } finally {
      clearInterval(timer);
      await this.release(name, owner).catch(() => undefined);
    }
  }
}
