/** POST /api/finalize-run：tick 只跑任务、汇总单独走轻请求（0.26.0）。
 *
 * 用 node:sqlite 内存后端 + 桩 Telegram 客户端（塞进 cachedClients，不走真实 MTProto）。
 * 汇总来源是 runSingleTask 每次写下的 run:${id}:outcome + tasks 行的 last_*，
 * tick 里续费中途断了、甚至 tick 本身没跑完，汇总也能重建；mergeDailySummary
 * 本身幂等，同一晚调多次结果不变。
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

function countingBackend(
  db: DatabaseSync,
  options: { budget?: number } = {},
): { backend: SqlBackend; count: () => number } {
  let n = 0;
  const budget = options.budget ?? 45;
  const backend: SqlBackend = {
    multiAccount: true,
    queryBudget: budget,
    async exec<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      n += 1;
      return db.prepare(sql).all(...(params as never[])) as T[];
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

function getSummary(db: DatabaseSync): { results: Array<{ botUsername: string; status: string }> } | null {
  const raw = getKvRaw(db, "acct:yanneo20:report:lastRunSummary");
  return raw ? (JSON.parse(raw) as { results: Array<{ botUsername: string; status: string }> }) : null;
}

/** 回包型假客户端：发文本后立刻回一条机器人回复，让单文本步任务快速跑完。 */
function replyingClient(): Record<string, unknown> {
  const history: Array<{ id: number; out: boolean; message: string }> = [{ id: 100, out: false, message: "上一条旧消息" }];
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

function seed(db: DatabaseSync, taskCount: number): number[] {
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  ).run("yanneo20", "yanneo20", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  const mkTask = db.prepare(
    `INSERT INTO tasks (account_id, name, enabled, target, schedule, steps, success_keywords, timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, next_run_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, '[]', 30, 1, 0, 1, ?, ?, ?)`,
  );
  const ids: number[] = [];
  for (let i = 1; i <= taskCount; i++) {
    const info = mkTask.run(
      "yanneo20",
      `任务${i}`,
      JSON.stringify({ kind: "user", id: `@example_bot${i}`, username: `example_bot${i}`, peerKind: "user" }),
      JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
      JSON.stringify([{ type: "text", text: "/start" }, { type: "text", text: "/sign" }]),
      now - 3600_000,
      now,
      now,
    );
    ids.push(Number(info.lastInsertRowid));
  }
  const put = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  put.run("acct:yanneo20:trigger:cursor:self", "100");
  put.run("acct:yanneo20:trigger:greeted:self", "1");
  put.run("acct:yanneo20:trigger:lastPoll", String(now));
  return ids;
}

function makeService(db: DatabaseSync, backend: SqlBackend) {
  const store = new Store(backend, "yanneo20");
  const service = new AgentService(store, {} as Env, new MemoryLock());
  const cache = (service as unknown as { cachedClients: Map<string, { client: unknown; key: string; touchedAt: number }> }).cachedClients;
  cache.set("yanneo20", { client: replyingClient(), key: "111111:session-dummy", touchedAt: Date.now() });
  return { store, service };
}

async function callFinalize(
  service: AgentService,
  body: Record<string, unknown> = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await service.fetch(
    new Request("http://localhost/finalize-run?account=yanneo20", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

test("finalize-run：tick 不再写汇总，finalize 后汇总出现，调两次不重复", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db, 2);
  const { backend, count } = countingBackend(db);
  const { store, service } = makeService(db, backend);

  const ticked = await service.tick(2);
  assert.equal(ticked.ran.length, 2, "2 个到期任务应跑完");
  assert.deepEqual(ticked.ran.map((r) => r.ok), [true, true]);
  assert.equal(getSummary(db), null, "tick 不再合并汇总：没调 finalize 时汇总应为空");

  const before = count();
  const first = await callFinalize(service);
  assert.equal(first.status, 200);
  assert.equal(first.data.ok, true);
  assert.equal(first.data.merged, 2, "2 个今天跑过的任务应全合并");
  assert.ok(count() - before <= 8, `finalize 应是轻请求，实测 ${count() - before} 条`);
  const summary = getSummary(db);
  assert.ok(summary, "finalize 后汇总应落库");
  assert.equal(summary.results.length, 2, "汇总应有 2 行");
  assert.deepEqual(
    summary.results.map((r) => r.botUsername).sort(),
    ["@example_bot1", "@example_bot2"],
  );
  assert.ok(summary.results.every((r) => r.status === "success"));

  // 再调一次：幂等，不重复
  const second = await callFinalize(service);
  assert.equal(second.status, 200);
  assert.equal(second.data.merged, 2);
  assert.equal(getSummary(db)?.results.length, 2, "重复 finalize 不应让汇总行数翻倍");
  void store;
});

test("finalize-run：只合并当天跑过的任务，昨天的不同进今天的汇总", async () => {
  const db = new DatabaseSync(":memory:");
  const [idA, idB] = seed(db, 2);
  const { backend } = countingBackend(db);
  const { service } = makeService(db, backend);
  const now = Date.now();
  const yesterday = now - 26 * 3600_000;
  const put = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  // 任务 A：今天跑过（outcome + tasks 行都是今天）
  put.run(
    `acct:yanneo20:run:${idA}:outcome`,
    JSON.stringify({ ok: true, replyText: "签到成功", replyFullText: "签到成功", allReplies: ["签到成功"], at: now, durationMs: 1000 }),
  );
  db.prepare("UPDATE tasks SET last_run_at = ?, last_result = 'ok', last_message = '签到成功' WHERE id = ?").run(now, idA);
  // 任务 B：昨天跑过（outcome + tasks 行都是昨天）
  put.run(
    `acct:yanneo20:run:${idB}:outcome`,
    JSON.stringify({ ok: true, replyText: "签到成功", replyFullText: "签到成功", allReplies: ["签到成功"], at: yesterday, durationMs: 1000 }),
  );
  db.prepare("UPDATE tasks SET last_run_at = ?, last_result = 'ok', last_message = '签到成功' WHERE id = ?").run(yesterday, idB);

  const res = await callFinalize(service);
  assert.equal(res.status, 200);
  assert.equal(res.data.merged, 1, "只有今天跑过的任务 A 应合并");
  assert.equal(getSummary(db)?.results.length, 1);
  assert.equal(getSummary(db)?.results[0].botUsername, "@example_bot1");
});

test("finalize-run：没 outcome 只有日志时也能兜底重建一行", async () => {
  const db = new DatabaseSync(":memory:");
  const [idA] = seed(db, 1);
  const { backend } = countingBackend(db);
  const { service } = makeService(db, backend);
  const now = Date.now();
  // 只有 tasks 行 + 一条执行日志，没有 run:outcome（老数据）
  db.prepare("UPDATE tasks SET last_run_at = ?, last_result = 'ok', last_message = '签到成功', last_detail = '已经签到' WHERE id = ?").run(now, idA);
  db.prepare(
    "INSERT INTO logs (account_id, task_id, task_name, at, ok, level, message, detail, source, duration_ms) VALUES (?, ?, ?, ?, 1, 'info', ?, ?, 'auto', ?)",
  ).run("yanneo20", idA, "任务1", now, "签到成功", "已经签到", 1500);

  const res = await callFinalize(service);
  assert.equal(res.status, 200);
  assert.equal(res.data.merged, 1, "没 outcome 也应从 tasks 行 + 日志兜底合并 1 行");
  const summary = getSummary(db);
  assert.equal(summary?.results.length, 1);
  assert.equal(summary?.results[0].status, "already", "detail 里有「已经签到」应判 already");
  assert.equal(summary?.results[0].botUsername, "@example_bot1");
});

test("finalize-run：taskIds 只合并指定的任务", async () => {
  const db = new DatabaseSync(":memory:");
  const [idA] = seed(db, 2);
  const { backend } = countingBackend(db);
  const { service } = makeService(db, backend);
  const ticked = await service.tick(2);
  assert.equal(ticked.ran.length, 2);

  const res = await callFinalize(service, { taskIds: [idA] });
  assert.equal(res.status, 200);
  assert.equal(res.data.merged, 1, "只指定 1 个任务就只合并 1 行");
  assert.equal(getSummary(db)?.results.length, 1);
  assert.equal(getSummary(db)?.results[0].botUsername, "@example_bot1");
});
