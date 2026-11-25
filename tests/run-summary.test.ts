/** GET /api/run-summary：不带 ?account= 时聚合各启用账号的汇总（0.26.1）。
 *
 * D1 多账号下汇总按账号前缀存（acct:<id>:report:lastRunSummary），裸键从来没人写，
 * 不聚合裸端点永远回 null；带 ?account= 时只返回该账号的汇总，行为不动。
 * 用 node:sqlite 内存后端，直接往 kv 里写两份汇总，再走 service.fetch 调端点。
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

function countingBackend(db: DatabaseSync): SqlBackend {
  return {
    multiAccount: true,
    queryBudget: 45,
    async exec<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async run(sql: string, ...params: unknown[]): Promise<void> {
      db.prepare(sql).run(...(params as never[]));
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>): Promise<void> {
      for (const s of statements) db.prepare(s.sql).run(...(s.params as never[]));
    },
  };
}

function seed(db: DatabaseSync): void {
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  const mkAccount = db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  );
  for (const id of ["yanneo20", "guanhuo03"]) {
    mkAccount.run(id, id, 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  }
}

function makeSummary(accountId: string, count: number, start: string, finish: string): Record<string, unknown> {
  return {
    date: "2026-11-25",
    runLabel: start,
    runStartedBeijing: start,
    runFinishedBeijing: finish,
    results: Array.from({ length: count }, (_, i) => ({
      accountId,
      botUsername: `@example_bot_${accountId}_${i + 1}`,
      status: "success",
      reply: "签到成功",
      ranAt: start,
      via: "auto",
    })),
    renewals: [
      {
        name: `示例机器人_${accountId}`,
        bot: `@example_bot_${accountId}_1`,
        outcome: "renewed",
        button: "续费7天",
        detail: "已续费",
      },
    ],
  };
}

function putSummary(db: DatabaseSync, accountId: string, summary: Record<string, unknown>): void {
  db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    `acct:${accountId}:report:lastRunSummary`,
    JSON.stringify(summary),
  );
}

function makeService(db: DatabaseSync): AgentService {
  // 初始 accountId 为空串，和 D1 入口（index-d1.ts）一致：裸端点不带账号
  const store = new Store(countingBackend(db), "");
  return new AgentService(store, {} as Env, new MemoryLock());
}

async function callRunSummary(
  service: AgentService,
  account?: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const url = account ? `http://localhost/run-summary?account=${account}` : "http://localhost/run-summary";
  const res = await service.fetch(new Request(url, { method: "GET" }));
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

test("run-summary：两账号各有汇总时裸端点返回合并的 20 行", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  putSummary(db, "yanneo20", makeSummary("yanneo20", 17, "11 月 25 日 00:03", "11 月 25 日 00:51"));
  putSummary(db, "guanhuo03", makeSummary("guanhuo03", 3, "11 月 25 日 00:52", "11 月 25 日 00:58"));
  const service = makeService(db);

  const res = await callRunSummary(service);
  assert.equal(res.status, 200);
  const summary = res.data.summary as Record<string, unknown> | null;
  assert.ok(summary, "两账号都有汇总时裸端点不应回 null");
  assert.equal(summary.date, "2026-11-25");
  assert.equal((summary.results as unknown[]).length, 20, "17 + 3 应合并为 20 行");
  assert.equal((summary.renewals as unknown[]).length, 2, "续费应合并为 2 条");
  assert.equal(summary.runLabel, "11 月 25 日 00:03", "runLabel 取当晚第一批的");
  assert.equal(summary.runStartedBeijing, "11 月 25 日 00:03", "runStartedBeijing 取最早");
  assert.equal(summary.runFinishedBeijing, "11 月 25 日 00:58", "runFinishedBeijing 取最晚");

  const one = await callRunSummary(service, "yanneo20");
  const oneSummary = one.data.summary as Record<string, unknown> | null;
  assert.ok(oneSummary, "带 ?account=yanneo20 应返回该账号的汇总");
  assert.equal((oneSummary.results as unknown[]).length, 17, "按账号调只返回该账号的 17 行");
  assert.equal((oneSummary.renewals as unknown[]).length, 1);
});

test("run-summary：一账号无汇总时只返回另一账号的", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  putSummary(db, "yanneo20", makeSummary("yanneo20", 17, "11 月 25 日 00:03", "11 月 25 日 00:51"));
  const service = makeService(db);

  const res = await callRunSummary(service);
  assert.equal(res.status, 200);
  const summary = res.data.summary as Record<string, unknown> | null;
  assert.ok(summary, "一个账号有汇总时裸端点不应回 null");
  assert.equal((summary.results as unknown[]).length, 17, "只返回有汇总的账号的 17 行");
  assert.equal((summary.renewals as unknown[]).length, 1);
  assert.equal(summary.date, "2026-11-25");
});

test("run-summary：两账号都无汇总时回 null", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const service = makeService(db);

  const res = await callRunSummary(service);
  assert.equal(res.status, 200);
  assert.equal(res.data.summary, null, "两账号都没汇总时保持现有空态");
});
