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
import { AgentService, TgAgent } from "../src/agent.ts";
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

/** 当前北京时间的星期（0=周一 … 6=周日，与 digestWeekday 一致）。 */
function beijingWeekday(): number {
  return (new Date(Date.now() + 8 * 3600_000).getUTCDay() + 6) % 7;
}

/** 桩 DurableObjectState：node:sqlite 包一层 SqlStorage，alarm 记在内存里。 */
function fakeDoState(db: DatabaseSync): {
  ctx: DurableObjectState;
  presetAlarm: (at: number | null) => void;
  getAlarm: () => number | null;
  deleteAlarmCalls: () => number;
  setAlarmCalls: () => number[];
} {
  let alarm: number | null = null;
  let deletes = 0;
  const sets: number[] = [];
  const sql = {
    exec(sqlText: string, ...params: unknown[]) {
      const stmt = db.prepare(sqlText);
      const returnsRows = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sqlText) || /RETURNING\b/i.test(sqlText);
      const rows = (
        returnsRows ? stmt.all(...(params as never[])) : (stmt.run(...(params as never[])), [])
      ) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
  const ctx = {
    storage: {
      sql,
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => {
        alarm = at;
        sets.push(at);
      },
      deleteAlarm: async () => {
        deletes += 1;
        alarm = null;
      },
    },
  } as unknown as DurableObjectState;
  return {
    ctx,
    presetAlarm: (at) => {
      alarm = at;
    },
    getAlarm: () => alarm,
    deleteAlarmCalls: () => deletes,
    setAlarmCalls: () => sets,
  };
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

// ---------- 往返写入（P0 回归）----------
//
// POST /api/settings 经 sanitizeSettings() 白名单过滤后落库：白名单漏了 paused，
// 开关写不进去、暂停实际无效。Worker 把 /api/settings 去掉 /api 前缀代理给 DO，
// 单测里直接调 DO 层的 /settings。
// 这条用例抓住 P0：置 paused:true → 读回为 true → tick() 返回空。

test("POST /settings 置 paused:true 能写进去：读回为 true，tick() 返回空", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const res = await service.fetch(
    new Request("http://localhost/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { settings: { paused?: boolean } };
  assert.equal(body.settings.paused, true, "POST /settings 应把 paused 写进去并回显");
  const stored = JSON.parse(getKvRaw(db, "settings") ?? "{}") as { paused?: boolean };
  assert.equal(stored.paused, true, "paused 应落库到 settings");

  const result = await service.tick(5);
  assert.deepEqual(result, { ran: [], remaining: 0, nextRunAt: null, queriesUsed: 0 });
  assert.equal(calls(), 0, "写进去的暂停应生效，tick 不应轮询");
});

// ---------- alarm 清除与恢复（TgAgent 层）----------
//
// 只断言 nextScheduledAt() 返回 null 不够：要断 scheduleNextAlarm() 分支
// 确实调了 deleteAlarm。TgAgent.fetch 每次请求后都会重排 alarm，
// 所以直接走 POST /settings 置开关，再看桩 storage 里的 alarm 变化。

test("暂停后已设的 alarm 确实被清除；取消暂停后重新设 alarm", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  const fake = fakeDoState(db);
  const agent = new TgAgent(fake.ctx, {} as Env);
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  fake.presetAlarm(now + 3600_000);

  const res = await agent.fetch(
    new Request("http://localhost/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: true }),
    }),
  );
  assert.equal(res.status, 200);
  assert.ok(fake.deleteAlarmCalls() >= 1, "暂停后 scheduleNextAlarm 应调 deleteAlarm");
  assert.equal(fake.getAlarm(), null, "已设的 alarm 应被清除");

  const res2 = await agent.fetch(
    new Request("http://localhost/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    }),
  );
  assert.equal(res2.status, 200);
  const alarm = fake.getAlarm();
  assert.ok(alarm !== null && alarm >= now + 5_000, "取消暂停后应重新设 alarm");
});

// ---------- 暂停时管理接口仍可用 ----------

test("paused=true 时登录/状态等管理接口仍可用", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "settings", JSON.stringify({ paused: true, notifyEvents: [] }));
  const { service, cache } = makeService(db, doBackend(db));
  const { client } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const stateRes = await service.fetch(new Request("http://localhost/state", { method: "GET" }));
  assert.equal(stateRes.status, 200);
  const state = (await stateRes.json()) as { settings: { paused?: boolean } };
  assert.equal(state.settings.paused, true, "状态接口应回显暂停开关");

  const accountsRes = await service.fetch(new Request("http://localhost/accounts", { method: "GET" }));
  assert.equal(accountsRes.status, 200);
});

// ---------- 取消暂停后恢复 tick ----------

test("取消暂停后 tick() 恢复：照常轮询，nextScheduledAt() 恢复返回时间", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  putKv(db, "settings", JSON.stringify({ paused: true, notifyEvents: [] }));
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const pausedResult = await service.tick(5);
  assert.deepEqual(pausedResult, { ran: [], remaining: 0, nextRunAt: null, queriesUsed: 0 });
  assert.equal(calls(), 0);

  const res = await service.fetch(
    new Request("http://localhost/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paused: false }),
    }),
  );
  assert.equal(res.status, 200);

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.ok(calls() >= 1, "取消暂停后超过 60 分钟未轮询应恢复轮询");
  const at = await service.nextScheduledAt();
  assert.ok(at !== null && at >= now + 5_000, "取消暂停后应恢复排 alarm");
});

// ---------- 周报 / 存储 / 成功率跳过要有断言 ----------
//
// 暂停的 tick() 在 listAccounts() 之前就返回，tickAccount 里的
// maybeSendWeeklyDigest / maybeCheckStorage / maybeCheckSuccessRate /
// maybeSendDigest 一件都不会跑：下面用哨兵值断言四处 kv 一个都没被重写。
// 哨兵是 1970 年的旧时间戳：未暂停时四处检查都已到点，都会重写，
// 所以对照组能证明这些断言不是空断言。

function seedDueChecks(db: DatabaseSync, now: number): void {
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  putKv(db, "notify:digest:lastAt", "1000");
  putKv(db, "notify:weekly:lastAt", "1000");
  putKv(db, "notify:storage:lastCheckAt", "1000");
  putKv(db, "notify:rate:lastCheckAt", "1000");
  putKv(
    db,
    "settings",
    JSON.stringify({
      paused: true,
      notifyEvents: ["daily_digest", "weekly_digest", "storage_warning", "success_rate_low"],
      digestHour: beijingHour(),
      digestWeekday: beijingWeekday(),
      weeklyHour: beijingHour(),
      storageWarnPercent: 70,
      successRateThreshold: 80,
    }),
  );
}

test("paused=true 时周报/存储/成功率/日报检查都不跑：四处 kv 保持哨兵值", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  seedDueChecks(db, now);
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.deepEqual(result, { ran: [], remaining: 0, nextRunAt: null, queriesUsed: 0 });
  assert.equal(calls(), 0);
  assert.equal(getKvRaw(db, "notify:digest:lastAt"), "1000", "日报不应重写 lastAt");
  assert.equal(getKvRaw(db, "notify:weekly:lastAt"), "1000", "周报不应重写 lastAt");
  assert.equal(getKvRaw(db, "notify:storage:lastCheckAt"), "1000", "存储检查不应重写 lastCheckAt");
  assert.equal(getKvRaw(db, "notify:rate:lastCheckAt"), "1000", "成功率检查不应重写 lastCheckAt");
});

test("对照组：未暂停时同一批到点检查都会重写 kv（上条不是空断言）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, now + 20 * 3600_000);
  seedDueChecks(db, now);
  putKv(db, "settings", JSON.stringify({
    paused: false,
    notifyEvents: ["daily_digest", "weekly_digest", "storage_warning", "success_rate_low"],
    digestHour: beijingHour(),
    digestWeekday: beijingWeekday(),
    weeklyHour: beijingHour(),
    storageWarnPercent: 70,
    successRateThreshold: 80,
  }));
  const { service, cache } = makeService(db, doBackend(db));
  const { client, calls } = fakeClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.ok(calls() >= 1, "未暂停时应恢复轮询");
  assert.notEqual(getKvRaw(db, "notify:digest:lastAt"), "1000", "日报到点应重写 lastAt");
  assert.notEqual(getKvRaw(db, "notify:weekly:lastAt"), "1000", "周报到点应重写 lastAt");
  assert.notEqual(getKvRaw(db, "notify:storage:lastCheckAt"), "1000", "存储检查到点应重写 lastCheckAt");
  assert.notEqual(getKvRaw(db, "notify:rate:lastCheckAt"), "1000", "成功率检查到点应重写 lastCheckAt");
});
