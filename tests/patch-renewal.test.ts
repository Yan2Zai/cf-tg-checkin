/**
 * PATCH 只改部分字段时，renewal 子对象要深合并，不能整体替换。
 *
 * 回归 0.27.9 的教训：钟陌 renewal.menuPath: [] 被一次只改步骤的面板保存抹掉
 * （面板编辑器保存时 menuPath 为空就不发），续费又走了 /shop。
 * 修法：agent.updateTask 里 renewal 深合并（没传的字段保留原值），
 * renewal:null 时照常清空。
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { test } from "./harness.ts";
import { doBackend, makeService } from "./do-helpers.ts";

function seed(db: DatabaseSync): void {
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const now = Date.now();
  db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  ).run("", "", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  db.prepare(
    `INSERT INTO tasks (account_id, name, enabled, target, schedule, steps, success_keywords, timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, renewal, next_run_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, '[]', 30, 3, 0, 1, ?, ?, ?, ?)`,
  ).run(
    "",
    "钟陌",
    JSON.stringify({ kind: "user", id: "1", username: "example_bot", peerKind: "bot" }),
    JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
    JSON.stringify([
      { type: "text", text: "/start" },
      { type: "click", text: "签到" },
      { type: "text", text: "/start" },
    ]),
    JSON.stringify({ enabled: true, button: "积分续期", minBalance: 6, infoCommand: "/start", menuPath: [] }),
    now + 3600_000,
    now,
    now,
  );
}

test("PATCH 只改步骤时，renewal 的 menuPath 空数组不被抹掉", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { store, service } = makeService(db, doBackend(db));
  const before = await store.getTask(1);
  assert.deepEqual(before?.renewal?.menuPath, [], "种子任务的 menuPath 应为空数组");

  const res = await service.fetch(
    new Request("http://localhost/tasks/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        steps: [
          { type: "text", text: "/start" },
          { type: "click", text: "签到" },
          { type: "text", text: "/start" },
        ],
      }),
    }),
  );
  assert.equal(res.status, 200);
  const after = await store.getTask(1);
  assert.deepEqual(after?.renewal?.menuPath, [], "只改步骤的 PATCH 不该抹掉 renewal.menuPath");
  assert.equal(after?.renewal?.button, "积分续期", "renewal 其余字段也应保留");
  assert.equal(after?.renewal?.minBalance, 6);
});

test("PATCH 发 renewal:null 时照常清空续费", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { store, service } = makeService(db, doBackend(db));
  const res = await service.fetch(
    new Request("http://localhost/tasks/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ renewal: null }),
    }),
  );
  assert.equal(res.status, 200);
  const after = await store.getTask(1);
  assert.equal(after?.renewal, undefined, "显式发 renewal:null 应清空续费");
});

test("PATCH 只改 renewal 一项时，没传的 renewal 字段保留原值", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const { store, service } = makeService(db, doBackend(db));
  const res = await service.fetch(
    new Request("http://localhost/tasks/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ renewal: { enabled: false } }),
    }),
  );
  assert.equal(res.status, 200);
  const after = await store.getTask(1);
  assert.equal(after?.renewal?.enabled, false, "传了 enabled:false 应生效");
  assert.deepEqual(after?.renewal?.menuPath, [], "没传的 menuPath 应保留原值");
  assert.equal(after?.renewal?.button, "积分续期", "没传的 button 应保留原值");
});

test("面板清空 menuPath 时发 menuPath:null，恢复默认 /shop", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  // 先把种子任务的 menuPath 改成一条真实路径，模拟“原来有路径、用户在面板上清空”
  db.prepare("UPDATE tasks SET renewal = ? WHERE id = 1").run(
    JSON.stringify({ enabled: true, button: "积分续期", minBalance: 6, infoCommand: "/start", menuPath: ["用户功能", "兑换商店"] }),
  );
  const { store, service } = makeService(db, doBackend(db));
  const before = await store.getTask(1);
  assert.deepEqual(before?.renewal?.menuPath, ["用户功能", "兑换商店"]);
  // 编辑器清空输入框时发 menuPath:null（见 public/editor.js 的保存逻辑）
  const res = await service.fetch(
    new Request("http://localhost/tasks/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ renewal: { menuPath: null } }),
    }),
  );
  assert.equal(res.status, 200);
  const after = await store.getTask(1);
  assert.equal(after?.renewal?.menuPath, undefined, "menuPath:null 应清掉路径、恢复默认 /shop");
  assert.equal(after?.renewal?.button, "积分续期", "清空 menuPath 不该动 renewal 其余字段");
  assert.equal(after?.renewal?.minBalance, 6);
});

test("重新启用停用的任务时，连续失败计数清零", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  // 模拟自动暂停后的状态：已停用、连续失败 4 次
  db.prepare("UPDATE tasks SET enabled = 0, fail_streak = 4 WHERE id = 1").run();
  const { store, service } = makeService(db, doBackend(db));
  const before = await store.getTask(1);
  assert.equal(before?.enabled, false);
  assert.equal(before?.failStreak, 4);
  const res = await service.fetch(
    new Request("http://localhost/tasks/1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    }),
  );
  assert.equal(res.status, 200);
  const after = await store.getTask(1);
  assert.equal(after?.enabled, true, "应重新启用");
  assert.equal(after?.failStreak, 0, "重新启用时 failStreak 应清零，否则再失败一次就立刻又被暂停");
});
