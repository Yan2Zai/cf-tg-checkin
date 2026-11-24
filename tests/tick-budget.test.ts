/** tick 的 D1 查询预算回归测试（2026-11-25 修的 bug）。
 *
 * 背景：D1 每调用 50 条查询，Store 在 45 条熔断。tick 一次循环全部账号，
 * 每账号“检查 + 触发轮询”约 13 条，每条新触发消息约 5 条（读默认目标×2 +
 * 写 lastEvent + 写日志×2）。两账号各 3 条新消息就到 45 条，直接报
 * 「D1 查询预算将超（45/50），请调小 limit」。
 *
 * 修法：tick() 认 ?account= 只跑单个账号；pollTriggers 按剩余预算限流，
 * 新消息只处理一部分，游标只推到已处理的那条；tick() 循环账号前检查剩余预算，
 * 不够就停下并让调用方再调一轮。
 *
 * 用 node:sqlite 内存后端 + 桩 Telegram 客户端（塞进 cachedClients，不走真实 MTProto）。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "./harness.ts";
import { Store } from "../src/db.ts";
import type { SqlBackend } from "../src/d1/backend.ts";
import { AgentService } from "../src/agent.ts";
import { MemoryLock } from "../src/d1/lock.ts";
import type { Env } from "../src/env.ts";

/** 计数型内存后端：每条 exec/run 都记数（复刻 D1Backend 的 45 条熔断）。 */
function countingBackend(db: DatabaseSync): { backend: SqlBackend; count: () => number } {
  let n = 0;
  const backend: SqlBackend = {
    multiAccount: true,
    queryBudget: 45,
    async exec<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      n += 1;
      const stmt = db.prepare(sql);
      return stmt.all(...(params as never[])) as T[];
    },
    async run(sql: string, ...params: unknown[]): Promise<void> {
      n += 1;
      db.prepare(sql).run(...(params as never[]));
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
      for (const s of statements) {
        n += 1;
        db.prepare(s.sql).run(...(s.params as never[]));
      }
    },
  };
  return { backend, count: () => n };
}

function seed(db: DatabaseSync): void {
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  const nextRun = now + 20 * 3600_000; // 下次 00:00（未来），模拟线上“没到期”
  const mkAccount = db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  );
  const mkTask = db.prepare(
    `INSERT INTO tasks (account_id, name, enabled, target, schedule, steps, success_keywords, timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, next_run_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, '[]', 30, 3, 0, 1, ?, ?, ?)`,
  );
  for (const acct of ["guanhuo03", "yanneo20"]) {
    mkAccount.run(acct, acct, 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  }
  const task = (acct: string, i: number) =>
    mkTask.run(
      acct,
      `任务${i}`,
      JSON.stringify({ kind: "user", id: `@bot${i}_bot`, username: `bot${i}_bot` }),
      JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
      JSON.stringify([{ type: "text", text: "/start" }, { type: "click", text: "签到" }]),
      nextRun,
      now,
      now,
    );
  for (let i = 1; i <= 3; i++) task("guanhuo03", i);
  for (let i = 1; i <= 17; i++) task("yanneo20", i);
}

/** 桩 Telegram 客户端：getMessages 返回给定的收藏夹消息，满足 pollTriggers/afterUse 的形状。 */
function fakeClient(messages: Array<{ id: number; message: string; out?: boolean }> = []): Record<string, unknown> {
  return {
    connected: true,
    session: { save: () => "", _entities: new Map() },
    getEntity: async () => ({}),
    getMessages: async () => messages.map((m) => ({ id: m.id, message: m.message, out: m.out ?? true })),
    sendMessage: async () => ({}),
    disconnect: async () => undefined,
  };
}

function makeService(db: DatabaseSync, backend: SqlBackend) {
  const store = new Store(backend, "");
  const service = new AgentService(store, {} as Env, new MemoryLock());
  const cache = (service as unknown as { cachedClients: Map<string, { client: unknown; key: string; touchedAt: number }> }).cachedClients;
  return { store, service, cache };
}

function setCursor(db: DatabaseSync, accountId: string, cursor: number): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`acct:${accountId}:trigger:cursor:self`, String(cursor));
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`acct:${accountId}:trigger:greeted:self`, "1");
}

function getCursor(db: DatabaseSync, accountId: string): number {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(`acct:${accountId}:trigger:cursor:self`) as { value: string } | undefined;
  return Number(row?.value ?? 0);
}

test("tick 预算：单账号 yanneo20（17 个任务）+ 3 条新触发消息，limit=5 不报预算错", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  const fresh = [101, 102, 103].map((i) => ({ id: i, message: `tg 测试指令 ${i}` }));
  cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20"); // 等价于 ?account=yanneo20

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.ok(count() <= 45, `查询数 ${count()} 应 ≤ 45`);
  assert.equal(getCursor(db, "yanneo20"), 103, "3 条新消息应全处理完，游标推到 103");
});

test("tick 预算：双账号各 10 条新触发消息，不报预算错，未跑完的账号让调用方再调一轮", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { service, cache } = makeService(db, backend);
  // 每号 10 条：两号合计超 45 条预算，第二个账号仍会被顺延（3 条时已能一轮跑完，测不到顺延）
  const fresh = Array.from({ length: 10 }, (_, i) => ({ id: 101 + i, message: `tg 测试指令 ${101 + i}` }));
  cache.set("guanhuo03", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "guanhuo03", 100);
  setCursor(db, "yanneo20", 100);

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.ok(count() <= 45, `查询数 ${count()} 应 ≤ 45`);
  assert.ok(result.remaining >= 1, "没跑完第二个账号时 remaining 应 ≥ 1，让调用方再调一轮");
});

test("tick 预算：单账号 20 条新触发消息，不报预算错，游标只推到已处理的，下轮继续", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  // 20 条：优化后一轮约能处理 14 条（每条约 2 条查询），剩下的下轮继续；用 10 条已一轮全跑完，测不到分批
  const fresh = Array.from({ length: 20 }, (_, i) => ({ id: 101 + i, message: `tg 测试指令 ${101 + i}` }));
  cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const first = await service.tick(5);
  assert.deepEqual(first.ran, []);
  assert.ok(count() <= 45, `首轮查询数 ${count()} 应 ≤ 45`);
  const cursorAfterFirst = getCursor(db, "yanneo20");
  assert.ok(cursorAfterFirst > 100 && cursorAfterFirst < 120, `首轮应只处理一部分新消息，游标=${cursorAfterFirst}`);

  // 下一轮（新 Store，预算重算；把 lastPoll 清掉模拟时间已过 60 秒轮询间隔）继续处理剩下的，不报错且游标继续前进
  db.prepare("DELETE FROM kv WHERE key = ?").run("acct:yanneo20:trigger:lastPoll");
  const { backend: backend2, count: count2 } = countingBackend(db);
  const next = makeService(db, backend2);
  next.cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  next.store.setAccountId("yanneo20");
  const second = await next.service.tick(5);
  assert.deepEqual(second.ran, []);
  assert.ok(count2() <= 45, `次轮查询数 ${count2()} 应 ≤ 45`);
  assert.ok(getCursor(db, "yanneo20") > cursorAfterFirst, "次轮游标应继续前进");
});

// ---------- 优化回归（0.25.0）：从根本上减少 SQL 条数 ----------
//
// 基线（0.24.0，探针实测）：单账号 3 条新消息 32 条、无新消息 14 条、
// 双账号 32 条只跑完一个号（第二个因预算 <16 被顺延）。
// 优化后目标：单账号 3 条新消息 ≤20、无新消息 ≤10、双账号一轮跑完两号且 ≤45。

test("tick 优化：单账号 yanneo20（17 个任务）+ 3 条新触发消息，limit=5，查询数 ≤ 20", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  const fresh = [101, 102, 103].map((i) => ({ id: i, message: `tg 测试指令 ${i}` }));
  cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.ok(count() <= 20, `查询数 ${count()} 应 ≤ 20（基线 32）`);
  assert.equal(getCursor(db, "yanneo20"), 103, "3 条新消息应全处理完，游标推到 103");
});

test("tick 优化：双账号各 3 条新触发消息，一轮跑完两个账号，查询数 ≤ 45", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { service, cache } = makeService(db, backend);
  const fresh = [101, 102, 103].map((i) => ({ id: i, message: `tg 测试指令 ${i}` }));
  cache.set("guanhuo03", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "guanhuo03", 100);
  setCursor(db, "yanneo20", 100);

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0, "两个账号都应在一轮跑完，不再顺延");
  assert.ok(count() <= 45, `查询数 ${count()} 应 ≤ 45`);
  assert.equal(getCursor(db, "guanhuo03"), 103, "guanhuo03 的 3 条新消息应全处理完");
  assert.equal(getCursor(db, "yanneo20"), 103, "yanneo20 的 3 条新消息应全处理完");
});

test("tick 优化：单账号 yanneo20 无新触发消息，limit=5，查询数 ≤ 10", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  cache.set("yanneo20", { client: fakeClient([]), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.ok(count() <= 10, `查询数 ${count()} 应 ≤ 10（基线 14）`);
});
