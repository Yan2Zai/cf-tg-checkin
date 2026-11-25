/** DO 限额优化（0.26.3）：闲时拉长触发轮询、缩短连接保温。
 *
 * 背景：DO 版每 60 秒醒一次（触发轮询间隔 pollSeconds 默认 60 秒），
 * 每次醒来连 MTProto + 保温 30 秒，占空比约 58%，两 Worker 合计
 * Duration 约 12,600 GB-s/天，贴着 13,000 的免费限额。
 *
 * 修法（只对 DO 生效，D1 靠 hasQueryBudget 判别保持原样）：
 * 1. 闲时触发轮询拉到 15 分钟：没任务在 10 分钟内到期时，
 *    nextScheduledAt / tick 的轮询间隔用 15 分钟代替 pollSeconds；
 *    任务临近时恢复 pollSeconds，签到不受影响。
 * 2. 连接保温 30 秒 → 5 秒：一次 tick 内的连续操作仍能复用连接
 *    （间隔是毫秒级），跨 tick 本来就复用不上（间隔 60 秒 > 30 秒），
 *    30 秒保温纯粹是白占 DO 常驻时长。
 *
 * 用 node:sqlite 内存后端 + 桩 Telegram 客户端（DO 单账号后端，
 * multiAccount=false、无查询预算），不走真实 MTProto。
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

/** DO 单账号后端：无 queryBudget（bump 永不触发），multiAccount=false。 */
function doBackend(db: DatabaseSync): SqlBackend {
  return {
    multiAccount: false,
    async exec<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      const stmt = db.prepare(sql);
      return stmt.all(...(params as never[])) as T[];
    },
    async run(sql: string, ...params: unknown[]): Promise<void> {
      db.prepare(sql).run(...(params as never[]));
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
      for (const s of statements) db.prepare(s.sql).run(...(s.params as never[]));
    },
  };
}

/** 计数型内存后端：模拟 D1（有 45 条查询预算），用来证明 D1 行为不受影响。 */
function countingBackend(db: DatabaseSync, budget = 45): { backend: SqlBackend; count: () => number } {
  let n = 0;
  const backend: SqlBackend = {
    multiAccount: true,
    queryBudget: budget,
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

function putKv(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

function getKvRaw(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** DO 版种子：一个远期任务 + 登录态 + 触发游标（key 都不带 acct: 前缀）。 */
function seedDo(db: DatabaseSync, nextRunAt: number): void {
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  // tasks.account_id 外键指向 accounts(id)：DO 单账号的空 id 也要补一行占位
  db.prepare("INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)")
    .run("", "", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  db.prepare(
    `INSERT INTO tasks (account_id, name, enabled, target, schedule, steps, success_keywords, timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, next_run_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, '[]', 30, 3, 0, 1, ?, ?, ?)`,
  ).run(
    "",
    "任务1",
    JSON.stringify({ kind: "user", id: "@example_bot", username: "example_bot", peerKind: "user" }),
    JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
    JSON.stringify([{ type: "text", text: "/start" }]),
    nextRunAt,
    now,
    now,
  );
  putKv(db, "account:session", "session-dummy");
  putKv(db, "account:creds", JSON.stringify({ apiId: 111111, apiHash: "hashhashhashhashhashhashhashhash" }));
  putKv(db, "trigger:cursor:self", "100");
  putKv(db, "trigger:greeted:self", "1");
}

/** D1 版种子：一个远期任务 + 登录态 + 触发游标（yanneo20 账号）。 */
function seedD1(db: DatabaseSync, nextRunAt: number): void {
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  ).run("yanneo20", "yanneo20", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  db.prepare(
    `INSERT INTO tasks (account_id, name, enabled, target, schedule, steps, success_keywords, timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, next_run_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, '[]', 30, 3, 0, 1, ?, ?, ?)`,
  ).run(
    "yanneo20",
    "任务1",
    JSON.stringify({ kind: "user", id: "@example_bot", username: "example_bot", peerKind: "user" }),
    JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
    JSON.stringify([{ type: "text", text: "/start" }]),
    nextRunAt,
    now,
    now,
  );
  putKv(db, "acct:yanneo20:trigger:cursor:self", "100");
  putKv(db, "acct:yanneo20:trigger:greeted:self", "1");
}

function fakeClient(): { client: Record<string, unknown>; calls: () => number } {
  let getMessagesCalls = 0;
  const client: Record<string, unknown> = {
    connected: true,
    session: { save: () => "", _entities: new Map() },
    getEntity: async () => ({}),
    getMessages: async () => {
      getMessagesCalls += 1;
      return [];
    },
    sendMessage: async () => ({}),
    disconnect: async () => undefined,
  };
  return { client, calls: () => getMessagesCalls };
}

function makeService(db: DatabaseSync, backend: SqlBackend) {
  const store = new Store(backend, "");
  const service = new AgentService(store, {} as Env, new MemoryLock());
  const cache = (service as unknown as { cachedClients: Map<string, { client: unknown; key: string; touchedAt: number }> }).cachedClients;
  return { store, service, cache };
}

const MIN = 60_000;

test("DO 闲时：没任务临近，nextScheduledAt 触发轮询候选拉到 15 分钟", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000); // 下次执行 20 小时后
  putKv(db, "trigger:lastPoll", String(now - 61_000)); // 上次轮询 61 秒前（已过 60 秒间隔）
  const { service } = makeService(db, doBackend(db));

  const at = await service.nextScheduledAt();
  assert.ok(at !== null, "应有下次唤醒时间");
  // 旧行为：lastPoll + 60 秒 ≈ now - 1 秒 → 钳到 now + 5 秒；
  // 新行为：lastPoll + 15 分钟 ≈ now + 14 分钟
  assert.ok(at >= now + 13 * MIN, `下次唤醒应在 13 分钟后，实测 ${((at - now) / MIN).toFixed(1)} 分钟`);
  assert.ok(at <= now + 16 * MIN, `下次唤醒不应超过 16 分钟，实测 ${((at - now) / MIN).toFixed(1)} 分钟`);
});

test("DO 忙时：任务 5 分钟内到期，触发轮询恢复 60 秒间隔", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 5 * MIN); // 任务 5 分钟后到期
  putKv(db, "trigger:lastPoll", String(now - 61_000));
  const { service } = makeService(db, doBackend(db));

  const at = await service.nextScheduledAt();
  assert.ok(at !== null, "应有下次唤醒时间");
  assert.ok(at <= now + 10_000, `任务临近时下次唤醒应在 10 秒内（轮询候选 lastPoll+60 秒已过），实测 ${at - now} 毫秒`);
});

test("DO 闲时 tick：轮询间隔未到，不连 Telegram", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "trigger:lastPoll", String(now - 61_000));
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.equal(calls(), 0, "闲时（距上次轮询 61 秒 < 15 分钟）不应拉控制会话消息");
  assert.equal(getKvRaw(db, "trigger:lastPoll"), String(now - 61_000), "没轮询就不该重写 lastPoll");
});

test("DO 闲时 tick：超过 15 分钟未轮询，恢复轮询（不是彻底停掉）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "trigger:lastPoll", String(now - 16 * MIN));
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.ok(calls() >= 1, "超过 15 分钟未轮询时应恢复轮询");
});

test("D1 不受影响：60 秒间隔仍轮询", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedD1(db, now + 20 * 3600_000);
  putKv(db, "acct:yanneo20:trigger:lastPoll", String(now - 61_000));
  const { backend } = countingBackend(db);
  const store = new Store(backend, "");
  const service = new AgentService(store, {} as Env, new MemoryLock());
  const cache = (service as unknown as { cachedClients: Map<string, { client: unknown; key: string; touchedAt: number }> }).cachedClients;
  const { client, calls } = fakeClient();
  cache.set("yanneo20", { client, key: "111111:session-dummy", touchedAt: Date.now() });
  store.setAccountId("yanneo20");

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.ok(calls() >= 1, "D1 版 60 秒间隔不变，61 秒后应轮询");
});

test("保温窗口：空闲 5 秒后断开连接，不再保温 30 秒", async () => {
  const db = new DatabaseSync(":memory:");
  seedDo(db, Date.now() + 20 * 3600_000);
  const { service, cache } = makeService(db, doBackend(db));
  let disconnected = false;
  const client = {
    connected: true,
    session: { save: () => "", _entities: new Map() },
    disconnect: async () => {
      disconnected = true;
    },
  };
  (service as unknown as { keepWarm: (accountId: string, client: unknown, key: string) => void }).keepWarm(
    "",
    client,
    "111111:session-dummy",
  );
  assert.equal(cache.size, 1, "保温开始时连接应在缓存里");
  // 等断开（最长 12 秒）：5 秒保温应在 8 秒内断开；旧的 30 秒保温 12 秒内不断
  const deadline = Date.now() + 12_000;
  while (!disconnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(disconnected, true, "空闲 5 秒后应断开连接（12 秒内没断说明还在按 30 秒保温）");
  assert.equal(cache.size, 0, "断开后缓存应清空");
});
