/** DO 彻底重构（0.27.0）：内存态为主、存储读写批量、无活不醒。
 *
 * 背景：DO 版 Duration 超免费限额（11-24 起回 502）。0.26.3 只改了闲时轮询
 * （15 分钟）和保温（5 秒），本轮在它之上彻底重构：
 * 1. 读路径内存化：Store 的任务/删除快照常驻 DO 实例（可重建的缓存），
 *    getTask / dueTasks / earliestNextRun / countDue / failStreakOf /
 *    dueDeletions / nextDeletionAt 命中快照时不再查库；暖机后的闲时 tick 零 SQL。
 * 2. 写路径批量化：DO 版轮询日志也攒批一次 INSERT（原来逐条），lastEvent
 *    只记内存、轮询结束与 lastPoll/游标一次 setKvMany 写回；日志/事件裁剪
 *    一小时最多跑一次（原来 DO 版每条日志都裁）。
 * 3. 无活不醒：闲时轮询按「距下次任务多远」分档（≤10 分钟用 pollSeconds；
 *    ≤60 分钟取 max(pollSeconds, 15 分钟)；更远/无任务取 max(pollSeconds, 60 分钟)）；
 *    没配控制会话时不为轮询设 alarm。
 * 4. 关键状态写仍即时落库（任务 nextRun/lastRun、触发游标在 finally 合并写回，
 *    驱逐只丢日志/lastEvent 这类可重建的），行为不变。
 *
 * 用 node:sqlite 内存后端 + 桩 Telegram 客户端（DO 单账号后端，
 * multiAccount=false、无查询预算），不走真实 MTProto。
 * 计数后端用来证明“命中快照时不再查库”。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "./harness.ts";
import { Store } from "../src/db.ts";
import type { SqlBackend } from "../src/d1/backend.ts";
import { doBackend, putKv, getKvRaw, makeService, MIN } from "./do-helpers.ts";

/** 计数型 DO 后端：记下每条 SQL 文本，用来证明“命中快照时不再查库”。 */
function countingDoBackend(db: DatabaseSync): {
  backend: SqlBackend;
  statements: string[];
  reset: () => void;
} {
  const statements: string[] = [];
  const backend: SqlBackend = {
    multiAccount: false,
    async exec<T>(sql: string, ...params: unknown[]): Promise<T[]> {
      statements.push(sql);
      const stmt = db.prepare(sql);
      return stmt.all(...(params as never[])) as T[];
    },
    async run(sql: string, ...params: unknown[]): Promise<void> {
      statements.push(sql);
      db.prepare(sql).run(...(params as never[]));
    },
    async batch(statements_: Array<{ sql: string; params: unknown[] }>): Promise<void> {
      for (const s of statements_) {
        statements.push(s.sql);
        db.prepare(s.sql).run(...(s.params as never[]));
      }
    },
  };
  return { backend, statements, reset: () => { statements.length = 0; } };
}

function putSettings(db: DatabaseSync, patch: Record<string, unknown>): void {
  putKv(db, "settings", JSON.stringify(patch));
}

/** DO 版种子：登录态 + 触发游标 + 若干任务（key 都不带 acct: 前缀）。 */
function seedDo(
  db: DatabaseSync,
  opts: { nextRunAts?: number[]; steps?: Array<{ type: string; text?: string }>; settings?: Record<string, unknown> } = {},
): void {
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  const nextRunAts = opts.nextRunAts ?? [now + 20 * 3600_000];
  db.prepare("INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)")
    .run("", "", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  const steps = opts.steps ?? [{ type: "text", text: "/start" }];
  nextRunAts.forEach((nextRunAt, i) => {
    db.prepare(
      `INSERT INTO tasks (account_id, name, enabled, target, schedule, steps, success_keywords, timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, next_run_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, '[]', 30, 3, 0, 1, ?, ?, ?)`,
    ).run(
      "",
      `任务${i + 1}`,
      JSON.stringify({ kind: "user", id: "@example_bot", username: "example_bot", peerKind: "user" }),
      JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
      JSON.stringify(steps),
      nextRunAt,
      now,
      now,
    );
  });
  putKv(db, "account:session", "session-dummy");
  putKv(db, "account:creds", JSON.stringify({ apiId: 111111, apiHash: "hashhashhashhashhashhashhashhash" }));
  putKv(db, "trigger:cursor:self", "100");
  putKv(db, "trigger:greeted:self", "1");
  if (opts.settings) putSettings(db, opts.settings);
}

/** 桩客户端：getMessages 按“发没发过消息”返回（发之前 []，发之后回一条签到成功）。 */
function fakeExecClient(): {
  client: Record<string, unknown>;
  sentCount: () => number;
  getMessagesCalls: () => number;
  disconnects: () => number;
} {
  let sent = false;
  let getMessagesCalls = 0;
  let disconnects = 0;
  const client: Record<string, unknown> = {
    connected: true,
    session: { save: () => "", _entities: new Map() },
    getEntity: async () => ({}),
    getPeerId: async () => null,
    getDialogs: async () => [],
    getMessages: async () => {
      getMessagesCalls += 1;
      // 没发过消息时历史为空（baseline=0）；发完后对方回一条“签到成功”
      return sent ? [{ id: 502, message: "签到成功", out: false }] : [];
    },
    sendMessage: async () => {
      sent = true;
      return { id: 501 };
    },
    disconnect: async () => {
      disconnects += 1;
    },
  };
  return { client, sentCount: () => (sent ? 1 : 0), getMessagesCalls: () => getMessagesCalls, disconnects: () => disconnects };
}

test("内存快照：listTasks 后 getTask 不再查库", async () => {
  const db = new DatabaseSync(":memory:");
  seedDo(db, {});
  const { backend, statements, reset } = countingDoBackend(db);
  const store = new Store(backend, "");
  const tasks = await store.listTasks();
  assert.equal(tasks.length, 1);
  reset();
  const got = await store.getTask(tasks[0].id);
  assert.equal(got?.id, tasks[0].id);
  await store.getTask(tasks[0].id);
  await store.getTask(tasks[0].id);
  assert.equal(statements.length, 0, `getTask 应走内存快照，实测 ${statements.length} 条 SQL：${statements.join(" | ")}`);
});

test("内存快照：listTasks 后 dueTasks/earliestNextRun/countDue 不再查库，结果与 SQL 一致", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { nextRunAts: [now - 1000, now + 3600_000] });
  const { backend, statements, reset } = countingDoBackend(db);
  const store = new Store(backend, "");
  await store.listTasks();
  reset();
  const due = await store.dueTasks(now);
  assert.deepEqual(due.map((t) => t.name), ["任务1"]);
  const limited = await store.dueTasks(now, 1);
  assert.equal(limited.length, 1);
  assert.equal(await store.earliestNextRun(), now - 1000);
  assert.equal(await store.countDue(now), 1);
  assert.equal(statements.length, 0, `到期查询应走内存快照，实测 ${statements.length} 条 SQL`);
});

test("内存快照：setTaskNextRun/recordRun 直接更新快照，listTasks 不再查库且值已变", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { nextRunAts: [now + 3600_000] });
  const { backend, statements, reset } = countingDoBackend(db);
  const store = new Store(backend, "");
  const task = (await store.listTasks())[0];
  reset();
  await store.setTaskNextRun(task.id, now + 7200_000);
  assert.equal(statements.length, 1, `setTaskNextRun 应只有 1 条 UPDATE，实测 ${statements.length} 条`);
  reset();
  const afterNext = await store.listTasks();
  assert.equal(afterNext[0].nextRunAt, now + 7200_000);
  assert.equal(statements.length, 0, "setTaskNextRun 后 listTasks 应走内存");
  await store.recordRun(task.id, "fail", "失败了", null, now, "auto");
  reset();
  const afterRun = await store.listTasks();
  assert.equal(afterRun[0].lastResult, "fail");
  assert.equal(afterRun[0].lastRunAt, now);
  assert.equal(afterRun[0].failStreak, 1);
  assert.equal(statements.length, 0, "recordRun 后 listTasks 应走内存");
  assert.equal(await store.failStreakOf(task.id), 1);
  assert.equal(statements.length, 0, "failStreakOf 应走内存快照");
});

test("recordRun 快照未加载时失败不重置 fail_streak（P1）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, {});
  // 库里已有连续失败 2 次，快照从未加载（不调 listTasks）
  db.prepare("UPDATE tasks SET fail_streak = 2 WHERE id = 1").run();
  const { backend, statements } = countingDoBackend(db);
  const store = new Store(backend, "");

  await store.recordRun(1, "fail", "失败了", null, now, "auto");
  // 库里的值 SQL 本来就算对了（fail_streak + 1，2 → 3）；这里断言它没被写成 1，
  // 并断言快照未加载时先读库拿旧值再写（第一条是读旧值的 SELECT，而不是上来就 UPDATE）。
  const streakInDb = () => (db.prepare("SELECT fail_streak AS v FROM tasks WHERE id = 1").get() as { v: number }).v;
  assert.equal(streakInDb(), 3, "快照未加载时失败一次，库里 fail_streak 应 2 → 3，而不是重置为 1");
  assert.equal(await store.failStreakOf(1), 3);
  assert.equal((await store.getTask(1))?.failStreak, 3);
  assert.ok(
    statements[0]?.startsWith("SELECT fail_streak"),
    `快照未加载时 recordRun 应先读库拿旧值，实测第一条 SQL：${statements[0] ?? "（无）"}`,
  );

  await store.recordRun(1, "fail", "又失败了", null, now + 1000, "auto");
  assert.equal(streakInDb(), 4, "再失败一次应 3 → 4");
  await store.recordRun(1, "ok", "成功了", null, now + 2000, "auto");
  assert.equal(streakInDb(), 0, "成功应清零");
});

test("updateTask 快照未加载时从库重读返回新值", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, {});
  const { backend, statements, reset } = countingDoBackend(db);
  const store = new Store(backend, "");
  // 只查单行，不加载快照
  const task = (await store.getTask(1))!;
  assert.equal(task.enabled, true);
  reset();
  const updated = await store.updateTask(task.id, { enabled: false }, now);
  assert.equal(updated?.enabled, false, "返回的任务应已停用");
  assert.equal(updated?.name, task.name, "其他字段应保持原值");
  assert.equal(updated?.failStreak, 0, "fail_streak 不应被 updateTask 捏造或改写");
  const updates = statements.filter((s) => s.startsWith("UPDATE tasks SET"));
  assert.equal(updates.length, 1, `updateTask 应只写 1 条 UPDATE，实测 ${updates.length} 条`);
  reset();
  const after = await store.listTasks();
  assert.equal(after[0].enabled, false, "重读快照后仍应是停用");
  assert.ok(statements.length >= 1, "快照未加载过，listTasks 应读库");
});

test("驱逐中途重处理：同一批触发消息跑两遍，建任务不重复、删除/开关幂等", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { settings: { notifyEvents: [], reportEnabled: false } });
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  const { service, cache, store } = makeService(db, doBackend(db));
  const messages = [
    { id: 101, message: "tg @example_bot 9.30 签到", out: true },
    { id: 102, message: "tg 删除 1", out: true },
    { id: 103, message: "tg 关闭 2", out: true },
  ];
  const client: Record<string, unknown> = {
    connected: true,
    session: { save: () => "", _entities: new Map() },
    getEntity: async () => ({}),
    getPeerId: async () => null,
    getDialogs: async () => [],
    getMessages: async () => messages,
    sendMessage: async () => ({}),
    disconnect: async () => undefined,
  };
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  // 第一轮：建出任务 #2，删掉种子任务 #1，停用新建的 #2
  await service.tick(5);
  let tasks = await store.listTasks();
  assert.equal(tasks.length, 1, "第一轮后应只剩新建的任务 #2");
  assert.equal(tasks[0].id, 2);
  assert.equal(tasks[0].enabled, false, "第一轮后 #2 应已停用");
  assert.equal(getKvRaw(db, "trigger:cursor:self"), "103", "游标应推到 103");

  // 模拟驱逐：游标没写回（回到 100），lastPoll 打回 61 分钟前，下轮重处理同一批消息
  await store.setKv("trigger:cursor:self", "100");
  await store.setKv("trigger:lastPoll", String(Date.now() - 61 * MIN));
  await service.tick(5);
  tasks = await store.listTasks();
  assert.equal(tasks.length, 1, "重处理后仍应只有 1 个任务（建任务指纹去重，不重复建）");
  assert.equal(tasks[0].id, 2, "重处理不应建出新任务");
  assert.equal(tasks[0].enabled, false, "重处理后 #2 仍应是停用（开关幂等）");
  assert.equal(getKvRaw(db, "trigger:cursor:self"), "103", "重处理后游标应再次推到 103");
});

test("内存快照：updateTask 只写 1 条 UPDATE，返回的新值直接进快照", async () => {
  const db = new DatabaseSync(":memory:");
  seedDo(db, {});
  const { backend, statements, reset } = countingDoBackend(db);
  const store = new Store(backend, "");
  const task = (await store.listTasks())[0];
  reset();
  const updated = await store.updateTask(task.id, { enabled: false }, Date.now());
  assert.equal(updated?.enabled, false);
  assert.equal(statements.length, 1, `updateTask 应只有 1 条 UPDATE，实测 ${statements.length} 条：${statements.join(" | ")}`);
  reset();
  const after = await store.listTasks();
  assert.equal(after[0].enabled, false);
  assert.equal(statements.length, 0, "updateTask 后 listTasks 应走内存");
});

test("内存快照：deleteTask 后快照失效，下次 listTasks 重读且任务已消失", async () => {
  const db = new DatabaseSync(":memory:");
  seedDo(db, {});
  const { backend, statements, reset } = countingDoBackend(db);
  const store = new Store(backend, "");
  const task = (await store.listTasks())[0];
  await store.deleteTask(task.id);
  reset();
  const after = await store.listTasks();
  assert.equal(after.length, 0);
  assert.ok(statements.length >= 1, "删除后快照应失效重读");
});

test("内存快照：dueDeletions/nextDeletionAt 只读一次，删完失效重读", async () => {
  const db = new DatabaseSync(":memory:");
  seedDo(db, {});
  const { backend, statements, reset } = countingDoBackend(db);
  const store = new Store(backend, "");
  const now = Date.now();
  await store.addDeletion("123", [11, 12], now - 1000);
  reset();
  const due = await store.dueDeletions(now);
  assert.equal(due.length, 1);
  assert.deepEqual(due[0].msgIds, [11, 12]);
  assert.equal(statements.length, 1, "第一次 dueDeletions 读一次库");
  reset();
  assert.equal(await store.nextDeletionAt(), now - 1000);
  assert.equal((await store.dueDeletions(now)).length, 1);
  assert.equal(statements.length, 0, "第二次起应走内存");
  await store.deleteDeletion(due[0].id);
  reset();
  assert.equal(await store.nextDeletionAt(), null);
  assert.ok(statements.length >= 1, "删完应失效重读");
});

test("日志裁剪节流：DO 版一小时内只裁一次（原来每条日志都裁）", async () => {
  const db = new DatabaseSync(":memory:");
  seedDo(db, {});
  const { backend, statements } = countingDoBackend(db);
  const store = new Store(backend, "");
  const base = { taskId: null, taskName: null, at: Date.now(), ok: true, level: "info" as const, message: "x", detail: null, source: "system" as const };
  await store.addLog(base);
  await store.addLog({ ...base, message: "y" });
  await store.addLog({ ...base, message: "z" });
  const prunes = statements.filter((s) => s.startsWith("DELETE FROM logs WHERE account_id = ? AND id <="));
  assert.equal(prunes.length, 1, `3 条日志应只裁 1 次，实测 ${prunes.length} 次`);
  const rows = db.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number };
  assert.equal(rows.n, 3);
});

test("DO 轮询日志批量写：2 条新触发消息的日志一次 INSERT，kv 合并写回", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  // 上次轮询 61 分钟前（远期任务档是 60 分钟，已到轮询时间）；前缀默认 "tg"，
  // 不带前缀但含时间词的消息会走“忽略：缺少前缀”分支，每条记 1 条日志
  seedDo(db, { settings: { notifyEvents: [], reportEnabled: false } });
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  const { backend, statements } = countingDoBackend(db);
  const { service, cache } = makeService(db, backend);
  let getMessagesCalls = 0;
  const client: Record<string, unknown> = {
    connected: true,
    session: { save: () => "", _entities: new Map() },
    getEntity: async () => ({}),
    getPeerId: async () => null,
    getMessages: async () => {
      getMessagesCalls += 1;
      if (getMessagesCalls === 1) {
        return [
          { id: 101, message: "9.30 签到", out: true },
          { id: 102, message: "9.30 签到", out: true },
        ];
      }
      return [];
    },
    sendMessage: async () => ({}),
    disconnect: async () => undefined,
  };
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.deepEqual(result.ran, []);
  assert.equal(getKvRaw(db, "trigger:cursor:self"), "102", "游标应推到 102");
  assert.ok(getKvRaw(db, "trigger:lastEvent"), "lastEvent 应写回");
  const logRows = db.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number };
  assert.equal(logRows.n, 3, "应有 3 条日志（发现 1 条 + 每条消息 1 条）");
  const logInserts = statements.filter((s) => s.startsWith("INSERT INTO logs"));
  assert.equal(logInserts.length, 1, `轮询日志应一次 INSERT 写完，实测 ${logInserts.length} 条 INSERT INTO logs`);
  const kvInserts = statements.filter((s) => s.startsWith("INSERT INTO kv"));
  // lastPoll 即时写 1 条 + 前缀提示 1 条 + finally 合并写回（lastPoll/游标/lastEvent）1 条
  assert.equal(kvInserts.length, 3, `轮询 kv 应只写 3 条 INSERT，实测 ${kvInserts.length} 条`);
});

test("暖机后闲时 tick 零 SQL：冷启动一次读全，之后不再碰存储", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { settings: { notifyEvents: [], reportEnabled: false } });
  putKv(db, "trigger:lastPoll", String(now)); // 刚轮询过，本轮不轮询、不跑任务
  const { backend, statements, reset } = countingDoBackend(db);
  const { service } = makeService(db, backend);

  const first = await service.tick(5);
  assert.deepEqual(first.ran, []);
  assert.ok(statements.length > 0, "冷启动应读库加载快照");
  assert.ok(statements.length <= 6, `冷启动读库应 ≤ 6 条，实测 ${statements.length} 条`);
  reset();
  const second = await service.tick(5);
  assert.deepEqual(second.ran, []);
  assert.equal(statements.length, 0, `暖机后闲时 tick 应零 SQL，实测 ${statements.length} 条：${statements.join(" | ")}`);
});

test("同 tick 内两次操作复用同一连接（不重连）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { settings: { notifyEvents: [], reportEnabled: false } });
  putKv(db, "trigger:lastPoll", String(now - 61 * MIN));
  const { service, cache, store } = makeService(db, doBackend(db));
  const { client, getMessagesCalls, disconnects } = fakeExecClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  await service.tick(5);
  assert.equal(getMessagesCalls(), 1, "第一轮应轮询一次");
  // 模拟“紧接着又有一次需要连接的操作”：把 lastPoll 打回 61 分钟前再 tick 一次
  await store.setKv("trigger:lastPoll", String(Date.now() - 61 * MIN));
  await service.tick(5);
  assert.equal(getMessagesCalls(), 2, "第二轮应在同一连接上再轮询一次");
  assert.equal(disconnects(), 0, "两次操作之间不应断开重连");
  assert.equal(cache.get("")?.client, client, "缓存里仍应是同一个客户端对象");
});

test("到期任务按时跑：关掉触发轮询时，alarm 时间就是任务时间（不是轮询时间）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { nextRunAts: [now + 90_000], settings: { triggerEnabled: false, notifyEvents: [] } });
  putKv(db, "trigger:lastPoll", String(now));
  const { service } = makeService(db, doBackend(db));

  const at = await service.nextScheduledAt();
  assert.ok(at !== null, "应有下次唤醒时间");
  assert.ok(at >= now + 80_000 && at <= now + 100_000, `下次唤醒应是任务时间（约 90 秒后），实测 ${(at - now) / 1000} 秒后`);
});

test("到期任务按时跑：到期的任务一轮 tick 就跑完，结果落库、下次执行已重排", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { nextRunAts: [now - 1000], settings: { notifyEvents: [], reportEnabled: false } });
  putKv(db, "trigger:lastPoll", String(now));
  const { service, cache } = makeService(db, doBackend(db));
  const { client } = fakeExecClient();
  cache.set("", { client, key: "111111:session-dummy", touchedAt: Date.now() });

  const result = await service.tick(5);
  assert.equal(result.ran.length, 1, "到期任务应跑 1 个");
  assert.equal(result.ran[0].ok, true, `任务应成功，实测：${result.ran[0].message}`);
  const nextRun = (db.prepare("SELECT next_run_at AS v FROM tasks").get() as { v: number }).v;
  assert.ok(nextRun > now, "下次执行应已重排到未来");
  const outcome = JSON.parse(getKvRaw(db, "run:1:outcome") ?? "null") as { ok: boolean } | null;
  assert.equal(outcome?.ok, true, "run:outcome 应落库且成功");
});

test("自适应闲时轮询：下次任务 20 小时后，轮询候选拉到 60 分钟（不再是 15 分钟）", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { nextRunAts: [now + 20 * 3600_000], settings: { notifyEvents: [] } });
  putKv(db, "trigger:lastPoll", String(now - 61_000));
  const { service } = makeService(db, doBackend(db));

  const at = await service.nextScheduledAt();
  assert.ok(at !== null, "应有下次唤醒时间");
  assert.ok(at >= now + 55 * MIN && at <= now + 60 * MIN, `下次唤醒应在约 59 分钟后（60 分钟档），实测 ${((at - now) / MIN).toFixed(1)} 分钟后`);
});

test("自适应闲时轮询：下次任务 30 分钟后，轮询候选 15 分钟", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { nextRunAts: [now + 30 * MIN], settings: { notifyEvents: [] } });
  putKv(db, "trigger:lastPoll", String(now - 61_000));
  const { service } = makeService(db, doBackend(db));

  const at = await service.nextScheduledAt();
  assert.ok(at !== null, "应有下次唤醒时间");
  assert.ok(at >= now + 13 * MIN && at <= now + 15 * MIN, `下次唤醒应在约 14 分钟后（15 分钟档），实测 ${((at - now) / MIN).toFixed(1)} 分钟后`);
});

test("自定义 pollSeconds=3600：闲时轮询取 max(3600 秒, 15 分钟)=60 分钟，不是 15 分钟", async () => {
  const db = new DatabaseSync(":memory:");
  const now = Date.now();
  seedDo(db, { nextRunAts: [now + 20 * 3600_000], settings: { pollSeconds: 3600, notifyEvents: [] } });
  putKv(db, "trigger:lastPoll", String(now - 61_000));
  const { service } = makeService(db, doBackend(db));

  const at = await service.nextScheduledAt();
  assert.ok(at !== null, "应有下次唤醒时间");
  assert.ok(at >= now + 55 * MIN && at <= now + 60 * MIN, `pollSeconds=3600 时下次唤醒应在约 59 分钟后，实测 ${((at - now) / MIN).toFixed(1)} 分钟后`);
});

test("无活不醒：没配控制会话时不为轮询设 alarm", async () => {
  const db = new DatabaseSync(":memory:");
  seedDo(db, { nextRunAts: [], settings: { controlChat: "", notifyEvents: [] } });
  // seedDo 默认插一个任务；上面 nextRunAts 为空时不插任务，删掉默认任务行
  db.prepare("DELETE FROM tasks").run();
  const { service } = makeService(db, doBackend(db));

  const at = await service.nextScheduledAt();
  assert.equal(at, null, "没任务、没控制会话、没日报时应无 alarm（DO 不醒）");
});
