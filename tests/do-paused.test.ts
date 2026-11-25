/** DO 暂停开关（0.27.1）：Settings.paused=true 时 DO 不执行任务、不设 alarm。
 *
 * 背景：删 CF cron 触发器并没有真正暂停 DO——DO 内部 alarm 由
 * scheduleNextAlarm() 按 nextScheduledAt() 自己排，独立于 CF 触发器。
 * DO 从 11-24 起 502 没跑过，库里任务 nextRunAt 仍是当天 00:00，恢复后
 * 补跑了一轮已由 D1 签过的任务，还把 serialize() 队列堵了几分钟，
 * 导致 /api/login 超时。paused=true 时 tick() 直接返回空结果
 * （不轮询、不跑任务、不发日报），nextScheduledAt() 返回 null，
 * scheduleNextAlarm() 随之删掉已设的 alarm，DO 不再自己醒来；
 * 登录/状态等管理接口保持可用。开关先由管理员经 /api/settings 设置，
 * 前端开关以后再加。
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
import { doBackend, putKv, getKvRaw, makeService, MIN } from "./do-helpers.ts";
import { DEFAULT_SETTINGS } from "../src/types.ts";

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

/** 当前北京时间的小时（日报到点判断用本地时区）。 */
function beijingHour(): number {
  return new Date(Date.now() + 8 * 3600_000).getUTCHours();
}

test("paused=true 时 tick() 不跑任务、不轮询、不发日报，返回空结果", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  // 轮询已到期（61 分钟没轮询，远期任务档 60 分钟该恢复轮询）+ 日报到点，
  // 未暂停时这两件事都会发生；暂停后一件都不该发生。
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  putKv(
    db,
    "settings",
    JSON.stringify({ paused: true, notifyEvents: ["daily_digest"], digestHour: beijingHour() }),
  );
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.deepEqual(result, { ran: [], remaining: 0, nextRunAt: null, queriesUsed: 0 });
  assert.equal(calls(), 0, "暂停后不应拉控制会话消息");
  assert.equal(getKvRaw(db, "trigger:lastPoll"), String(now - 61 * MIN), "没轮询就不该重写 lastPoll");
  assert.equal(getKvRaw(db, "notify:digest:lastAt"), null, "暂停后不应发日报");
});

test("paused=true 时 nextScheduledAt() 返回 null（alarm 随之被清除）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "settings", JSON.stringify({ paused: true, notifyEvents: [] }));
  putKv(db, "trigger:lastPoll", String(now - 61_000));
  const { service } = makeService(db, doBackend(db));

  assert.equal(await service.nextScheduledAt(), null, "暂停后不应再排 alarm");
});

test("paused=false（默认）时行为不变：tick 正常轮询、nextScheduledAt 正常返回时间", async () => {
  assert.equal(DEFAULT_SETTINGS.paused, false, "默认不暂停");
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.ok(result.nextRunAt !== null, "未暂停时应返回下次执行时间");
  assert.ok(calls() >= 1, "未暂停时超过 60 分钟未轮询应恢复轮询");

  const at = await service.nextScheduledAt();
  assert.ok(at !== null, "未暂停时应有下次唤醒时间");
  assert.ok(at >= now + 5_000, "下次唤醒不应早于 5 秒后");
});

/** 计数型内存后端：模拟 D1（有 45 条查询预算），只计数不设限。 */
function countingBackend(db: DatabaseSync): SqlBackend {
  return {
    multiAccount: true,
    queryBudget: 45,
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

test("D1 不受影响：paused=true 也不暂停（D1 是唯一签到通道）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  ).run("yanneo20", "yanneo20", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  putKv(db, "acct:yanneo20:settings", JSON.stringify({ paused: true }));
  putKv(db, "acct:yanneo20:trigger:lastPoll", String(now - 61_000));
  const store = new Store(countingBackend(db), "");
  const service = new AgentService(store, {} as Env, new MemoryLock());
  const cache = (service as unknown as { cachedClients: Map<string, { client: unknown; key: string; touchedAt: number }> }).cachedClients;
  const { client, calls } = fakeClient();
  cache.set("yanneo20", { client, key: "111111:session-dummy", touchedAt: Date.now() });
  store.setAccountId("yanneo20");

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.ok(calls() >= 1, "D1 版 paused 不生效，61 秒后仍应轮询");
});
