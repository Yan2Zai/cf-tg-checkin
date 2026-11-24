/** POST /api/finalize-run 入参校验（0.26.2）。
 *
 * 空合并（merged:0）不写汇总、不碰 report:lastRunSummary；错日期、不存在的
 * taskIds、不带 ?account= 一律回 400；body 为 null、date 为数字这类异常输入
 * 不抛 500。用 node:sqlite 内存后端 + 桩 Telegram 客户端，不走真实 MTProto。
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
import { beijingDate } from "../src/renew.ts";

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

function getSummary(db: DatabaseSync): { results: Array<{ botUsername: string }> } | null {
  const raw = getKvRaw(db, "acct:yanneo20:report:lastRunSummary");
  return raw ? (JSON.parse(raw) as { results: Array<{ botUsername: string }> }) : null;
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

function makeService(db: DatabaseSync, backend: SqlBackend, accountId = "yanneo20") {
  const store = new Store(backend, accountId);
  const service = new AgentService(store, {} as Env, new MemoryLock());
  const cache = (service as unknown as { cachedClients: Map<string, { client: unknown; key: string; touchedAt: number }> }).cachedClients;
  cache.set("yanneo20", { client: replyingClient(), key: "111111:session-dummy", touchedAt: Date.now() });
  return { store, service };
}

async function callFinalizeRaw(
  service: AgentService,
  url: string,
  rawBody: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await service.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rawBody),
    }),
  );
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

async function callFinalize(
  service: AgentService,
  body: Record<string, unknown> = {},
): Promise<{ status: number; data: Record<string, unknown> }> {
  return callFinalizeRaw(service, "http://localhost/finalize-run?account=yanneo20", body);
}

test("finalize-run：不带 ?account= 回 400，不写汇总", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db, 1);
  const { backend } = countingBackend(db);
  // D1 多账号下 Store 默认 accountId 是空串（见 src/index-d1.ts）
  const { service } = makeService(db, backend, "");
  const noAccount = await callFinalizeRaw(service, "http://localhost/finalize-run", {});
  assert.equal(noAccount.status, 400, "不带 ?account= 应回 400，而不是 ok:true 的空操作");
  const unknownAccount = await callFinalizeRaw(service, "http://localhost/finalize-run?account=not_exist", {});
  assert.equal(unknownAccount.status, 400, "不存在的账号 id 也应回 400");
  assert.equal(getSummary(db), null, "被拒的调用不应写汇总");
});

test("finalize-run：错日期回 400（不存在的日期、未来的日期）", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db, 1);
  const { backend } = countingBackend(db);
  const { service } = makeService(db, backend);
  for (const date of ["2026-02-30", "2026-13-01", "2026-11-25x", beijingDate(Date.now() + 48 * 3600_000, 8)]) {
    const res = await callFinalize(service, { date });
    assert.equal(res.status, 400, `date=${date} 应回 400，实测 ${res.status}`);
  }
  assert.equal(getSummary(db), null, "被拒的调用不应写汇总");
});

test("finalize-run：body 异常不抛 500", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db, 1);
  const { backend } = countingBackend(db);
  const { service } = makeService(db, backend);
  // body 为 null：按默认（今天）走，没跑过就 merged:0
  const nullBody = await callFinalizeRaw(service, "http://localhost/finalize-run?account=yanneo20", null);
  assert.equal(nullBody.status, 200, `body 为 null 不应抛 500，实测 ${nullBody.status}`);
  assert.equal(nullBody.data.merged, 0);
  // date 为数字：String 强制转换后格式不合法 → 400，不是 TypeError 500
  const numberDate = await callFinalize(service, { date: 20261125 });
  assert.equal(numberDate.status, 400, `date 为数字应回 400，实测 ${numberDate.status}`);
  // taskIds 不是数组 / 有非数字 / 有不存在的 id → 400
  for (const taskIds of ["1", [1.5], [99999]]) {
    const res = await callFinalize(service, { taskIds });
    assert.equal(res.status, 400, `taskIds=${JSON.stringify(taskIds)} 应回 400，实测 ${res.status}`);
  }
});

test("finalize-run：空合并 merged:0，不写汇总、不碰 report:lastRunSummary", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db, 2);
  const { backend } = countingBackend(db);
  const { service } = makeService(db, backend);
  // 当天没跑过：空合并直接返回，汇总指针还是空
  const empty = await callFinalize(service);
  assert.equal(empty.status, 200);
  assert.equal(empty.data.merged, 0);
  assert.equal(getSummary(db), null, "空合并不应新建汇总");
  assert.equal(getKvRaw(db, "acct:yanneo20:report:lastRunSummary"), null, "空合并不应碰汇总指针");

  // 跑一轮并 finalize，汇总落库后记下指针原值
  const ticked = await service.tick(2);
  assert.equal(ticked.ran.length, 2);
  const merged = await callFinalize(service);
  assert.equal(merged.data.merged, 2);
  assert.equal(getSummary(db)?.results.length, 2);
  const pointerBefore = getKvRaw(db, "acct:yanneo20:report:lastRunSummary");
  assert.ok(pointerBefore, "finalize 后汇总指针应有值");

  // 再对没有跑过的昨天 finalize：merged:0，指针原值不动，也没新建昨天的 daily key
  const yesterday = beijingDate(Date.now() - 48 * 3600_000, 8);
  const emptyYesterday = await callFinalize(service, { date: yesterday });
  assert.equal(emptyYesterday.status, 200);
  assert.equal(emptyYesterday.data.merged, 0, "昨天没跑过，应 merged:0");
  assert.equal(
    getKvRaw(db, "acct:yanneo20:report:lastRunSummary"),
    pointerBefore,
    "空合并不应覆盖 report:lastRunSummary",
  );
  assert.equal(getKvRaw(db, `acct:yanneo20:report:daily:${yesterday}`), null, "空合并不应新建昨天的 daily 汇总");
  assert.equal(getSummary(db)?.results.length, 2, "原有汇总结果不应被空合并清空");
});
