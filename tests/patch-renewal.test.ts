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
