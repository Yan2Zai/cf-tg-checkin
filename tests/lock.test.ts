/** D1 租约锁：抢锁 / 抢不到 / 过期重抢 / 续租 / 释放 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { D1Lock, MemoryLock } from "../src/d1/lock.ts";

/** 内存版 D1Database 替身：只实现 D1Lock 用到的 prepare/bind/run，模拟 locks 表的 UPSERT 语义。 */
function mockDb() {
  const locks = new Map<string, { owner: string; expiresAt: number }>();
  const db = {
    prepare(sql: string) {
      const bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound.push(...args);
          return this;
        },
        async run() {
          if (sql.includes("INSERT INTO locks")) {
            const [name, owner, expiresAt, now] = bound as [string, string, number, number];
            const existing = locks.get(name);
            if (!existing || existing.expiresAt <= now) {
              locks.set(name, { owner, expiresAt });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("DELETE FROM locks")) {
            const [name, owner] = bound as [string, string];
            const existing = locks.get(name);
            if (existing && existing.owner === owner) {
              locks.delete(name);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (sql.includes("UPDATE locks SET expires_at")) {
            const [expiresAt, name, owner] = bound as [number, string, string];
            const existing = locks.get(name);
            if (existing && existing.owner === owner) {
              existing.expiresAt = expiresAt;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          throw new Error(`未预期的 SQL：${sql.slice(0, 60)}`);
        },
      };
    },
    _locks: locks,
  };
  return db as unknown as D1Database;
}

test("D1Lock：抢到锁能执行，执行完自动释放", async () => {
  const lock = new D1Lock(mockDb());
  const out = await lock.withLock("exec:test-a", async () => "done");
  assert.deepEqual(out, { locked: true, result: "done" });
});

test("D1Lock：锁被占时返回 locked: false，不执行回调", async () => {
  const db = mockDb();
  const lock = new D1Lock(db);
  const owner = await lock.acquire("exec:test-a", 60_000);
  assert.ok(owner);
  let ran = false;
  const out = await lock.withLock("exec:test-a", async () => {
    ran = true;
    return "x";
  });
  assert.deepEqual(out, { locked: false });
  assert.equal(ran, false);
  await lock.release("exec:test-a", owner!);
  const out2 = await lock.withLock("exec:test-a", async () => "y");
  assert.deepEqual(out2, { locked: true, result: "y" });
});

test("D1Lock：租约过期后能重抢（旧 owner 的锁失效）", async () => {
  const db = mockDb();
  const lock = new D1Lock(db);
  const owner = await lock.acquire("exec:test-a", 1);
  assert.ok(owner);
  // 等租约过期（1ms）
  await new Promise((resolve) => setTimeout(resolve, 5));
  const out = await lock.withLock("exec:test-a", async () => "reacquired");
  assert.deepEqual(out, { locked: true, result: "reacquired" });
});

test("D1Lock：续租成功延长租约，续租失败返回 false", async () => {
  const db = mockDb();
  const lock = new D1Lock(db);
  const owner = await lock.acquire("exec:test-a", 60_000);
  assert.ok(owner);
  assert.equal(await lock.renew("exec:test-a", owner!, 60_000), true);
  assert.equal(await lock.renew("exec:test-a", "not-the-owner", 60_000), false);
  assert.equal(await lock.renew("exec:no-such-lock", owner!, 60_000), false);
});

test("D1Lock：不同账号的锁互不干扰", async () => {
  const db = mockDb();
  const lock = new D1Lock(db);
  const ownerA = await lock.acquire("exec:guanhuo03", 60_000);
  assert.ok(ownerA);
  const outB = await lock.withLock("exec:yanneo20", async () => "b");
  assert.deepEqual(outB, { locked: true, result: "b" });
  const outA = await lock.withLock("exec:guanhuo03", async () => "a");
  assert.deepEqual(outA, { locked: false });
});

test("MemoryLock：永远能排上队，按顺序执行", async () => {
  const lock = new MemoryLock();
  const order: number[] = [];
  const [a, b] = await Promise.all([
    lock.withLock("exec:x", async () => {
      order.push(1);
      return 1;
    }),
    lock.withLock("exec:x", async () => {
      order.push(2);
      return 2;
    }),
  ]);
  assert.deepEqual(a, { locked: true, result: 1 });
  assert.deepEqual(b, { locked: true, result: 2 });
  assert.deepEqual(order, [1, 2]);
});
