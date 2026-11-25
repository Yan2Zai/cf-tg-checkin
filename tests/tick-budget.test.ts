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
import { Store, queryUsageHigh } from "../src/db.ts";
import type { SqlBackend } from "../src/d1/backend.ts";
import { AgentService } from "../src/agent.ts";
import { MemoryLock } from "../src/d1/lock.ts";
import type { Env } from "../src/env.ts";

/** 计数型内存后端：每条 exec/run 都记数（复刻 D1Backend 的 45 条熔断）。
 * options.budget：查询预算（默认 45；传小值可强制触发预算限流，测分批）；
 * options.multiAccount：false 时模拟 DO 单账号后端（无 accounts 表、无预算）。 */
function countingBackend(
  db: DatabaseSync,
  options: { budget?: number; multiAccount?: boolean } = {},
): { backend: SqlBackend; count: () => number } {
  let n = 0;
  const budget = options.budget ?? 45;
  const backend: SqlBackend = {
    multiAccount: options.multiAccount ?? true,
    ...(budget === undefined ? {} : { queryBudget: budget }),
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

/** DO 单账号后端：无 queryBudget（bump 永不触发），multiAccount=false。 */
function doBackend(db: DatabaseSync): { backend: SqlBackend; count: () => number } {
  let n = 0;
  const backend: SqlBackend = {
    multiAccount: false,
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

/** 读 kv 原值（测试用，直接查库，不走 Store 计数）。 */
function getKvRaw(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** 读 trigger:lastEvent（测试用）。 */
function getLastEvent(db: DatabaseSync, accountId: string): { at: number; ok: boolean; message: string } | null {
  const raw = getKvRaw(db, `acct:${accountId}:trigger:lastEvent`);
  return raw ? (JSON.parse(raw) as { at: number; ok: boolean; message: string }) : null;
}

/** 某账号的日志条数（测试用）。 */
function countLogs(db: DatabaseSync, accountId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM logs WHERE account_id = ?").get(accountId) as { n: number };
  return Number(row?.n ?? 0);
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
      JSON.stringify({ kind: "user", id: `@bot${i}_bot`, username: `bot${i}_bot`, peerKind: "user" }),
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

test("tick 预算：双账号各 10 条新触发消息，小预算下未跑完的账号让调用方再调一轮", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db, { budget: 20 });
  const { service, cache } = makeService(db, backend);
  // 预算 20：第一账号约 5 条，剩 15 条 < 16，第二账号被顺延（单消息几乎不花查询，
  // 45 条预算下两号都能一轮跑完，测不到顺延，故用小预算测分批机制本身；
  // 预算不能再小：tick 循环要求剩 ≥16 才开下一个账号，20 是刚好让次轮能开第二账号的值）
  const fresh = Array.from({ length: 10 }, (_, i) => ({ id: 101 + i, message: `tg 测试指令 ${101 + i}` }));
  cache.set("guanhuo03", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "guanhuo03", 100);
  setCursor(db, "yanneo20", 100);

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.ok(count() <= 20, `查询数 ${count()} 应 ≤ 20`);
  assert.ok(result.remaining >= 1, "没跑完第二个账号时 remaining 应 ≥ 1，让调用方再调一轮");
  assert.equal(getCursor(db, "guanhuo03"), 110, "第一账号的 10 条新消息应全处理完");
  assert.equal(getCursor(db, "yanneo20"), 100, "第二账号未跑，游标不动");

  // 下一轮（新 Store，预算重算；清掉 lastPoll 模拟时间已过 60 秒轮询间隔）继续跑第二账号
  db.prepare("DELETE FROM kv WHERE key IN (?, ?)").run(
    "acct:guanhuo03:trigger:lastPoll",
    "acct:yanneo20:trigger:lastPoll",
  );
  const { backend: backend2, count: count2 } = countingBackend(db, { budget: 20 });
  const next = makeService(db, backend2);
  next.cache.set("guanhuo03", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  next.cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  const second = await next.service.tick(5);
  assert.deepEqual(second.ran, []);
  assert.ok(count2() <= 20, `次轮查询数 ${count2()} 应 ≤ 20`);
  assert.equal(getCursor(db, "yanneo20"), 110, "次轮第二账号的 10 条新消息应全处理完");
  assert.equal(second.remaining, 0, "两号都跑完后 remaining 应为 0");
});

test("tick 预算：单账号 20 条新触发消息，一轮全处理完，lastEvent 不丢", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  // 20 条简单消息：单条几乎不花查询（日志批量写、lastEvent 合并写），一轮全跑完
  const fresh = Array.from({ length: 20 }, (_, i) => ({ id: 101 + i, message: `tg 测试指令 ${101 + i}` }));
  cache.set("yanneo20", { client: fakeClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const first = await service.tick(5);
  assert.deepEqual(first.ran, []);
  assert.ok(count() <= 45, `首轮查询数 ${count()} 应 ≤ 45`);
  assert.equal(getCursor(db, "yanneo20"), 120, "20 条新消息应一轮全处理完，游标推到 120");
  assert.equal(first.remaining, 0);
  // lastEvent 落库：最近一条（120 号消息）的事件已记，不缺
  const lastEvent = getLastEvent(db, "yanneo20");
  assert.ok(lastEvent, "lastEvent 应已落库");
  assert.equal(lastEvent.ok, false);
  assert.match(lastEvent.message, /触发解析失败/);
  // 日志批量写：21 条日志（1 发现 + 20 消息）一条不少
  assert.equal(countLogs(db, "yanneo20"), 21, "20 条消息应产生 21 条日志（1 发现 + 20 消息）");
});

// ---------- 优化回归（0.25.0 → 0.25.1）：从根本上减少 SQL 条数 ----------
//
// 基线（0.24.0，探针实测）：单账号 3 条新消息 32 条、无新消息 14 条、
// 双账号 32 条只跑完一个号（第二个因预算 <16 被顺延）。
// 0.25.0 目标：单账号 3 条新消息 ≤20、无新消息 ≤10、双账号一轮跑完两号且 ≤45。
// 0.25.1 目标（补齐合并读/批量写）：单账号 3 条新消息 ≤8、无新消息 ≤4、
// 双账号一轮跑完两号且 ≤15；20 条简单消息一轮全处理完。

test("tick 优化：单账号 yanneo20（17 个任务）+ 3 条新触发消息，limit=5，查询数 ≤ 8", async () => {
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
  assert.ok(count() <= 8, `查询数 ${count()} 应 ≤ 8（0.25.0 基线 20）`);
  assert.equal(getCursor(db, "yanneo20"), 103, "3 条新消息应全处理完，游标推到 103");
  // 日志批量写：4 条日志（1 发现 + 3 消息）一条不少
  assert.equal(countLogs(db, "yanneo20"), 4, "3 条消息应产生 4 条日志（1 发现 + 3 消息）");
  // lastEvent 落库：最近一条消息的事件已记
  const lastEvent = getLastEvent(db, "yanneo20");
  assert.ok(lastEvent, "lastEvent 应已落库");
  assert.equal(lastEvent.ok, false);
  assert.match(lastEvent.message, /触发解析失败/);
});

test("tick 优化：双账号各 3 条新触发消息，一轮跑完两个账号，查询数 ≤ 15", async () => {
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
  assert.ok(count() <= 15, `查询数 ${count()} 应 ≤ 15（0.25.0 基线 45）`);
  assert.equal(getCursor(db, "guanhuo03"), 103, "guanhuo03 的 3 条新消息应全处理完");
  assert.equal(getCursor(db, "yanneo20"), 103, "yanneo20 的 3 条新消息应全处理完");
  // 两账号 lastEvent 都落库
  assert.ok(getLastEvent(db, "guanhuo03"), "guanhuo03 lastEvent 应落库");
  assert.ok(getLastEvent(db, "yanneo20"), "yanneo20 lastEvent 应落库");
});

test("tick 优化：单账号 yanneo20 无新触发消息，limit=5，查询数 ≤ 4", async () => {
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
  // 目标：listAccounts 1 + 预取合并读 1 + 合并写 1 + 最终 earliestNextRun 1 = 4
  assert.ok(count() <= 4, `查询数 ${count()} 应 ≤ 4（0.25.0 基线 10）`);
});

// ---------- 第二轮优化（0.25.1）：补齐 Spec 缺口 ----------
//
// 1. 合并读做完：设置/lastPoll/游标/digest/下次执行/due 计数一次预取（见上面 ≤4/≤8/≤15 的收紧目标）。
// 2. 日志批量写：多条日志一次 INSERT（见上面日志条数断言）。
// 3. 没配 controlChat 的账号跳过触发轮询（本节）。
// 4. lastEvent 不丢：finally 写回 + 每轮落库（见上面 lastEvent 断言与 DO/ D1 时机测试）。
// 5. DO 行为隔离：addLog 裁剪节流与 lastEvent 延迟写只对 D1 生效（本节）。

test("触发轮询：没配 controlChat 的账号跳过轮询", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  // controlChat 置空（默认是 "self"）；直接写 kv，绕过 Store 计数
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run("acct:yanneo20:settings", JSON.stringify({ controlChat: "" }));
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  let getMessagesCalls = 0;
  const client = {
    ...fakeClient([{ id: 101, message: "tg 测试指令 101" }]),
    getMessages: async () => {
      getMessagesCalls += 1;
      return [{ id: 101, message: "tg 测试指令 101", out: true }];
    },
  };
  cache.set("yanneo20", { client, key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(result.remaining, 0);
  assert.equal(getMessagesCalls, 0, "没配 controlChat 就不该拉控制会话消息");
  assert.equal(getKvRaw(db, "acct:yanneo20:trigger:lastPoll"), null, "没轮询就不该写 lastPoll");
  assert.equal(getCursor(db, "yanneo20"), 100, "没轮询游标不动");
  assert.ok(count() <= 4, `查询数 ${count()} 应 ≤ 4（跳过轮询后只剩检查）`);
});

test("日志裁剪节流：DO 与 D1 一小时内都只裁一次", async () => {
  const entry = {
    taskId: null,
    taskName: null,
    at: Date.now(),
    ok: true,
    level: "info" as const,
    message: "测试日志",
    detail: null,
    source: "system" as const,
  };
  // D1：首条 INSERT+DELETE=2，次条一小时内只 INSERT=1，合计 3
  {
    const db = new DatabaseSync(":memory:");
    seed(db);
    const { backend, count } = countingBackend(db);
    const store = new Store(backend, "yanneo20");
    await store.addLog(entry);
    await store.addLog(entry);
    assert.equal(count(), 3, `D1 两条日志应 3 条查询（首条 2 + 次条 1），实测 ${count()}`);
  }
  // DO：同样节流（0.27.0 起与 D1 一致，不再每条都裁）
  {
    const db = new DatabaseSync(":memory:");
    seed(db);
    // logs.account_id 外键指向 accounts(id)：DO 的空账号 id 在 D1 schema 里不存在，补一行占位
    db.prepare("INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)")
      .run("", "", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", Date.now(), Date.now());
    const { backend, count } = doBackend(db);
    const store = new Store(backend, "");
    await store.addLog(entry);
    await store.addLog(entry);
    assert.equal(count(), 3, `DO 两条日志应 3 条查询（首条 2 + 次条 1），实测 ${count()}`);
  }
});

test("lastEvent 写入时机：DO 与 D1 都延迟到轮询结束才写", async () => {
  // 用一条会回帮助文本的消息：record() 先于 reply()，sendMessage 被调时
  // 两版的 lastEvent 都还在内存（轮询结束才落库）。
  const fresh = [{ id: 101, message: "tg 测试指令 101" }];
  // ---- DO 版：sendMessage 时 lastEvent 还在内存，轮询结束才落库 ----
  {
    const db = new DatabaseSync(":memory:");
    seed(db);
    // logs.account_id 外键指向 accounts(id)：DO 的空账号 id 在 D1 schema 里不存在，补一行占位
    db.prepare("INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)")
      .run("", "", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", Date.now(), Date.now());
    const { backend } = doBackend(db);
    const { service, cache } = makeService(db, backend);
    let lastEventDuringSend: string | null = null;
    const client = {
      ...fakeClient(fresh),
      sendMessage: async () => {
        lastEventDuringSend = getKvRaw(db, "trigger:lastEvent");
        return {};
      },
    };
    cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });
    // DO 单账号：会话在旧 kv 里（account:session），游标/问候也不带 acct: 前缀；
    // withClient 还要 account:creds（apiId/apiHash），否则直接报“还没配置”
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("account:session", "session-dummy");
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("account:creds", JSON.stringify({ apiId: 111111, apiHash: "hashhashhashhashhashhashhashhash" }));
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("trigger:cursor:self", "100");
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run("trigger:greeted:self", "1");
    const result = await service.tick(5);
    assert.equal(result.remaining, 0);
    assert.equal(lastEventDuringSend, null, "DO 版：sendMessage 时 lastEvent 还在内存，不应已在库里（延迟写）");
    assert.ok(getKvRaw(db, "trigger:lastEvent"), "DO 版：轮询结束后 lastEvent 应已落库");
    assert.equal(Number(getKvRaw(db, "trigger:cursor:self")), 101, "DO 版游标应推到 101");
  }
  // ---- D1 版：sendMessage 时 lastEvent 还在内存，轮询结束才落库 ----
  {
    const db = new DatabaseSync(":memory:");
    seed(db);
    const { backend } = countingBackend(db);
    const { store, service, cache } = makeService(db, backend);
    let lastEventDuringSend: string | null = null;
    const client = {
      ...fakeClient(fresh),
      sendMessage: async () => {
        lastEventDuringSend = getKvRaw(db, "acct:yanneo20:trigger:lastEvent");
        return {};
      },
    };
    cache.set("yanneo20", { client, key: "111111:session-dummy", touchedAt: Date.now() });
    setCursor(db, "yanneo20", 100);
    store.setAccountId("yanneo20");
    const result = await service.tick(5);
    assert.equal(result.remaining, 0);
    assert.equal(lastEventDuringSend, null, "D1 版：sendMessage 时 lastEvent 还在内存，不应已在库里（延迟写）");
    assert.ok(getLastEvent(db, "yanneo20"), "D1 版：轮询结束后 lastEvent 应已落库");
    assert.equal(getCursor(db, "yanneo20"), 101, "D1 版游标应推到 101");
  }
});

// ---------- 设置守卫（0.25.3，P0-1）----------
//
// D1 版设置按账号存（acct:<id>:settings）。不带 ?account= 时 Store 的 accountId
// 是空串，设置会静默写到没人读的裸键 "settings"，界面上改完实际没生效。
// 守卫：D1 版不带 ?account= 直接拒绝；DO 单账号版不受影响。

test("设置守卫：D1 版不带 ?account= 调 POST /api/settings 应被拒绝，不写裸键", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend } = countingBackend(db);
  const { service } = makeService(db, backend);
  const res = await service.fetch(
    new Request("http://localhost/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ digestHour: 21 }),
    }),
  );
  assert.equal(res.status, 400, "不带 ?account= 应拒绝");
  assert.equal(getKvRaw(db, "settings"), null, "不写没人读的裸键");
  assert.equal(getKvRaw(db, "acct:yanneo20:settings"), null, "不污染分账号设置");
  assert.equal(getKvRaw(db, "acct:guanhuo03:settings"), null, "不污染分账号设置");
});

test("设置守卫：D1 版带 ?account= 正常写分账号设置；DO 版不带也能写", async () => {
  // D1：带账号正常保存
  {
    const db = new DatabaseSync(":memory:");
    seed(db);
    const { backend } = countingBackend(db);
    const { service } = makeService(db, backend);
    const res = await service.fetch(
      new Request("http://localhost/settings?account=yanneo20", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digestHour: 21 }),
      }),
    );
    assert.equal(res.status, 200);
    const saved = JSON.parse(getKvRaw(db, "acct:yanneo20:settings") ?? "{}") as { digestHour?: number };
    assert.equal(saved.digestHour, 21, "分账号设置应写到 acct:yanneo20:settings");
    assert.equal(getKvRaw(db, "settings"), null, "不写裸键");
    assert.equal(getKvRaw(db, "acct:guanhuo03:settings"), null, "另一个账号不受影响");
  }
  // DO：单账号，不带 ?account= 仍可保存（守卫只对 D1 生效）
  {
    const db = new DatabaseSync(":memory:");
    seed(db);
    db.prepare("INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)")
      .run("", "", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", Date.now(), Date.now());
    const { backend } = doBackend(db);
    const { service } = makeService(db, backend);
    const res = await service.fetch(
      new Request("http://localhost/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ digestHour: 21 }),
      }),
    );
    assert.equal(res.status, 200);
    const saved = JSON.parse(getKvRaw(db, "settings") ?? "{}") as { digestHour?: number };
    assert.equal(saved.digestHour, 21, "DO 版裸键就是本账号的设置，应正常写");
  }
});

// ---------- 预取游标（0.25.3，P3-4）----------
//
// prefetchTickState 的 kvKeys 里游标/问候 key 写死 "self"，controlChat 是群/频道时
// 预取的 key 全错，后面 getKv 只能再查库。修法：预取后按设置里的 controlChat
// 把真正的 key 也取进缓存（只在 controlChat 不是 self 时多 1 条查询）。

test("预取游标：controlChat 不是 self 时，预取也取真正的游标 key", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const put = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  put.run("acct:yanneo20:settings", JSON.stringify({ controlChat: "@example_group" }));
  put.run("acct:yanneo20:trigger:cursor:@example_group", "42");
  put.run("acct:yanneo20:trigger:greeted:@example_group", "1");
  const { backend, count } = countingBackend(db);
  const store = new Store(backend, "yanneo20");
  const prefetch = await store.prefetchTickState(Date.now());
  assert.ok(prefetch, "账号存在时预取应返回结果");
  assert.equal(await store.getKv("trigger:cursor:@example_group"), "42", "真正的游标 key 应已预取");
  assert.equal(await store.getKv("trigger:greeted:@example_group"), "1", "真正的问候 key 应已预取");
  assert.ok(count() <= 2, `预取 + 两次读应 ≤ 2 条查询（预取 1 + 补取 1），实测 ${count()}`);
});

// ---------- 用量预警（0.25.5，P2-7）----------
//
// tick 返回里带本调用实际用的查询数（queriesUsed）；超过预算 80%
// （45 条的 80% = 36 条）记一条警告日志，提醒下轮可能触发预算熔断。
// DO 没有查询预算，不受影响（queriesUsed 为 0，不记日志）。

test("用量预警：tick 返回 queriesUsed，等于本调用实际用的查询数", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  cache.set("yanneo20", { client: fakeClient([]), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(5);
  assert.equal(result.remaining, 0);
  assert.equal(
    (result as { queriesUsed?: number }).queriesUsed,
    count(),
    `queriesUsed 应等于后端实际计数 ${count()}`,
  );
  // 没超 80%，不应记警告
  assert.equal(countLogs(db, "yanneo20"), 0, "用量没超 80% 时不应记警告日志");
});

test("用量预警：36 条不报、37 条报（80% 边界）", async () => {
  assert.equal(queryUsageHigh(36, 45), false, "36 条是 80% 整，不报");
  assert.equal(queryUsageHigh(37, 45), true, "37 条超过 80%，报");
  assert.equal(queryUsageHigh(0, 45), false);
  assert.equal(queryUsageHigh(45, 45), true);
  assert.equal(queryUsageHigh(5, 0), false, "没预算（DO）不报");
});

/** 回包型假客户端：发文本后立刻回一条机器人回复，让单文本步任务快速跑完。 */
function replyingClient(fresh: Array<{ id: number; message: string }> = []): Record<string, unknown> {
  const history: Array<{ id: number; out: boolean; message: string }> = [
    { id: 100, out: false, message: "上一条旧消息" },
    ...fresh.map((m) => ({ id: m.id, out: true, message: m.message })),
  ];
  let nextId = 500;
  return {
    connected: true,
    session: { save: () => "", _entities: new Map() },
    getEntity: async () => ({}),
    getDialogs: async () => [],
    getPeerId: async () => 1,
    getMessages: async () => history.slice(),
    sendMessage: async () => {
      history.push({ id: nextId, out: true, message: "/start" });
      nextId += 1;
      history.push({ id: nextId, out: false, message: "签到成功" });
      nextId += 1;
      return { id: nextId - 2 };
    },
    deleteMessages: async () => undefined,
    disconnect: async () => undefined,
  };
}

test("用量预警：单账号 3 个两步任务 + 3 条触发消息 + 1 条到期删除，用量超 36 条时记一条警告日志", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  // 3 个到期任务改成两步文本（每任务约 11 条）+ 3 条新触发消息（约 +3 条）+
  // 1 条到期删除（dueDeletions 1 + deleteDeletion 1），让本轮用量稳落在 37~40 条：
  // 超 80%（36 条）但留得出警告日志的余量。0.26.0 之前单任务就要 33 条，
  // 两步任务 + 3 条触发消息就超 36；压查询后单任务只要约 11 条，
  // 必须 3 个任务一起跑才摸得到 80% 的线。
  const past = Date.now() - 3600_000;
  db.prepare("UPDATE tasks SET next_run_at = ?, steps = ? WHERE account_id = ? AND id IN (SELECT id FROM tasks WHERE account_id = ? LIMIT 3)")
    .run(past, JSON.stringify([{ type: "text", text: "/start" }, { type: "text", text: "/sign" }]), "yanneo20", "yanneo20");
  db.prepare("INSERT INTO deletions (account_id, chat, msg_ids, due_at) VALUES (?, ?, ?, ?)")
    .run("yanneo20", "123456789", "[1]", past);
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  const fresh = [101, 102, 103].map((i) => ({ id: i, message: `tg 测试指令 ${i}` }));
  cache.set("yanneo20", { client: replyingClient(fresh), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(3);
  assert.equal(result.ran.length, 3, "3 个到期任务应跑完");
  assert.deepEqual(result.ran.map((r) => r.ok), [true, true, true], "任务应成功");
  const queriesUsed = (result as { queriesUsed?: number }).queriesUsed!;
  assert.ok(queriesUsed > 36, `用量应超 36 条，实测 ${queriesUsed}`);
  assert.ok(queriesUsed <= 45, `用量不应超预算，实测 ${queriesUsed}`);
  assert.equal(queriesUsed, count(), "queriesUsed 应等于后端实际计数（含警告日志本身）");
  const warnLogs = db.prepare("SELECT message FROM logs WHERE account_id = ? AND level = 'warn' AND message LIKE '%查询用量偏高%'").all("yanneo20") as Array<{ message: string }>;
  assert.equal(warnLogs.length, 1, "超 80% 应恰好记一条警告日志");
  assert.match(warnLogs[0].message, /用了 \d+\/45 条/);
});

// ---------- 压查询（0.26.0）：live 中间态只记内存、日志攒批、recordEvent 合并 ----------
//
// 基线（0.25.7 探针实测）：limit=1 两步任务 32–43 条——live 逐条落库是大头
// （开始 + 每步 + 结束约 11 条）、recordEvent 4 条、failStreak 读两次、
// 汇总合并 3 条（0.26.0 拆到 finalize；0.26.2 postRun 又合入续费约 3 条，
// 任务结果仍只在 finalize 合并，见 finalize.test.ts）。
// 0.26.0 目标：limit=1 ≤ 25、limit=3 ≤ 40（离 45 至少留 5 条余量）。

test("压查询：单账号 1 个两步任务，limit=1 查询数 ≤ 25", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const past = Date.now() - 3600_000;
  db.prepare("UPDATE tasks SET next_run_at = ?, steps = ? WHERE account_id = ? AND id IN (SELECT id FROM tasks WHERE account_id = ? LIMIT 1)")
    .run(past, JSON.stringify([{ type: "text", text: "/start" }, { type: "text", text: "/sign" }]), "yanneo20", "yanneo20");
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  cache.set("yanneo20", { client: replyingClient([]), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(1);
  assert.equal(result.ran.length, 1, "1 个到期任务应跑完");
  assert.equal(result.ran[0].ok, true, "任务应成功");
  assert.equal(result.remaining, 0);
  // 探针实测 19 条（0.26.2 续费合入汇总 +3，0.26.0 基线 16 条）
  assert.ok(count() <= 25, `查询数 ${count()} 应 ≤ 25（0.25.7 基线 32–43）`);
  assert.equal((result as { queriesUsed?: number }).queriesUsed, count(), "queriesUsed 应等于后端实际计数");
});

test("压查询：单账号 3 个两步任务，limit=3 查询数 ≤ 40", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const past = Date.now() - 3600_000;
  db.prepare("UPDATE tasks SET next_run_at = ?, steps = ? WHERE account_id = ? AND id IN (SELECT id FROM tasks WHERE account_id = ? LIMIT 3)")
    .run(past, JSON.stringify([{ type: "text", text: "/start" }, { type: "text", text: "/sign" }]), "yanneo20", "yanneo20");
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  cache.set("yanneo20", { client: replyingClient([]), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(3);
  assert.equal(result.ran.length, 3, "3 个到期任务应跑完");
  assert.deepEqual(result.ran.map((r) => r.ok), [true, true, true], "任务应成功");
  assert.equal(result.remaining, 0);
  // 探针实测 38 条：3 个任务一轮跑完，离 45 条自限留 7 条余量，limit=3 安全
  //（0.26.2 续费合入汇总 +3、超 80% 的用量预警日志 +1；0.26.0 基线 34 条）
  assert.ok(count() <= 40, `查询数 ${count()} 应 ≤ 40（探针实测 38，离 45 留 7 条余量）`);
  assert.equal((result as { queriesUsed?: number }).queriesUsed, count(), "queriesUsed 应等于后端实际计数");
});

test("recordEvent：计数器一次 UPSERT 自增，两次调用 ≤ 5 条查询且计数对", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { backend, count } = countingBackend(db);
  const store = new Store(backend, "yanneo20");
  await store.recordEvent("run_finished:ok");
  await store.recordEvent("run_finished:ok");
  // 首条 UPSERT 1 + INSERT 1 + 裁剪 1 = 3，次条 UPSERT 1 + INSERT 1 = 2（裁剪一小时一跑）
  assert.ok(count() <= 5, `两次 recordEvent 应 ≤ 5 条查询，实测 ${count()}`);
  assert.equal(await store.countEvent("run_finished:ok"), 2, "计数器应累计 2 次");
  const samples = await store.listEventSamples("run_finished", Date.now() - 3600_000);
  assert.equal(samples.length, 2, "events 表应有 2 条样本");
});

test("日志批量写：补齐目标信息日志与执行日志一次写完，两条日志都在", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const past = Date.now() - 3600_000;
  // 目标去掉 peerKind，逼 ensureTarget 走补齐分支（多 1 条补齐日志 + 1 次 updateTask）
  const taskRow = db.prepare("SELECT id FROM tasks WHERE account_id = ? LIMIT 1").get("yanneo20") as { id: number };
  db.prepare("UPDATE tasks SET target = ?, next_run_at = ?, steps = ? WHERE id = ?").run(
    JSON.stringify({ kind: "user", id: "@example_bot", username: "example_bot" }),
    past,
    JSON.stringify([{ type: "text", text: "/start" }, { type: "text", text: "/sign" }]),
    taskRow.id,
  );
  const { backend, count } = countingBackend(db);
  const { store, service, cache } = makeService(db, backend);
  cache.set("yanneo20", { client: replyingClient([]), key: "111111:session-dummy", touchedAt: Date.now() });
  setCursor(db, "yanneo20", 100);
  store.setAccountId("yanneo20");

  const result = await service.tick(1);
  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].ok, true, "任务应成功");
  const logs = db.prepare("SELECT message FROM logs WHERE account_id = ? AND task_id = ? ORDER BY id").all("yanneo20", taskRow.id) as Array<{ message: string }>;
  assert.equal(logs.length, 2, "补齐日志 + 执行日志应都在（攒批一次写完，1 条 INSERT 顶 2 条）");
  assert.match(logs[0].message, /补齐目标信息/);
  assert.match(logs[1].message, /签到成功/);
  assert.ok(count() <= 25, `补齐分支多花 updateTask 3 条，总查询数 ${count()} 仍应 ≤ 25`);
});

