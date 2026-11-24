/** D1 备份导出（0.25.5，P1-5）。
 *
 * D1 是单点，没有兜底。GET /api/backup（机器认证）导出任务 / 账号 / 设置 /
 * 续费配置，供每日定时任务拉取后存档（现有全屋备份归档到 R2 + GitHub）。
 * 备份里绝不能有敏感值：apiId / apiHash / session / 口令 / Turnstile 密钥 /
 * Webhook 加签密钥 / Webhook 地址明文 / 管理员 ID 明文，恢复时另行填入。
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
  const nextRun = now + 20 * 3600_000;
  const put = db.prepare(
    "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  ).run("guanhuo03", "关火", 111111, "hashhashhashhashhashhashhashhash", "session-dummy", now, now);
  db.prepare(
    "INSERT INTO accounts (id, label, enabled, api_id, api_hash, session, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)",
  ).run("yanneo20", "大号", 222222, "anotherhashhashhashhashhashhash", "session-other", now, now);
  // 设置里故意放敏感值：备份必须脱敏或删掉，恢复时另行填入
  put.run(
    "acct:guanhuo03:settings",
    JSON.stringify({
      digestHour: 21,
      controlChat: "self",
      turnstileSecretKey: "turnstile-secret-xxx",
      notifyWebhookSecret: "webhook-sign-secret-xxx",
      notifyWebhook: "https://oapi.dingtalk.com/robot/send?access_token=token-xxx",
      adminUserId: "6541960132",
    }),
  );
  const mkTask = db.prepare(
    `INSERT INTO tasks (account_id, name, enabled, target, schedule, steps, success_keywords, timeout_seconds, step_delay_seconds, delete_after_seconds, cleanup_previous, renewal, next_run_at, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?, ?, '[]', 30, 1, 0, 1, ?, ?, ?, ?)`,
  );
  mkTask.run(
    "guanhuo03",
    "乐观签到",
    JSON.stringify({ kind: "user", id: "@bot1_bot", username: "bot1_bot" }),
    JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
    JSON.stringify([{ type: "text", text: "/start" }, { type: "click", text: "签到" }]),
    JSON.stringify({ enabled: true, button: "续费7天", minBalance: 700, infoCommand: "/profile" }),
    nextRun,
    now,
    now,
  );
  mkTask.run(
    "yanneo20",
    "宸宇签到",
    JSON.stringify({ kind: "user", id: "@bot2_bot", username: "bot2_bot" }),
    JSON.stringify({ kind: "daily", time: "00:00", jitterSeconds: 180 }),
    JSON.stringify([{ type: "text", text: "/start" }]),
    null,
    nextRun,
    now,
    now,
  );
}

interface BackupAccount {
  id: string;
  label?: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  tasks: Array<Record<string, unknown>>;
}

interface Backup {
  format: string;
  version: number;
  exportedAt: number;
  accounts: BackupAccount[];
}

function makeService(db: DatabaseSync): AgentService {
  const store = new Store(countingBackend(db), "");
  return new AgentService(store, {} as Env, new MemoryLock());
}

test("备份导出：含两账号的任务 / 设置 / 续费配置，不含任何敏感值", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const service = makeService(db);

  const backup = (await service.buildBackup()) as unknown as Backup;
  assert.equal(backup.format, "cf-tg-checkin.d1-backup");
  assert.equal(backup.version, 1);
  assert.ok(backup.exportedAt > 0);
  assert.equal(backup.accounts.length, 2);

  const guanhuo = backup.accounts.find((a) => a.id === "guanhuo03");
  assert.ok(guanhuo, "应有 guanhuo03");
  assert.equal(guanhuo.label, "关火");
  assert.equal(guanhuo.enabled, true);
  assert.equal(guanhuo.tasks.length, 1);
  assert.equal(guanhuo.tasks[0].name, "乐观签到");
  // 续费配置完整保留（恢复后不用重配阈值）
  assert.deepEqual(guanhuo.tasks[0].renewal, {
    enabled: true,
    button: "续费7天",
    minBalance: 700,
    infoCommand: "/profile",
  });
  // 非敏感设置保留
  assert.equal(guanhuo.settings.digestHour, 21);
  assert.equal(guanhuo.settings.controlChat, "self");
  // 敏感值只剩“配没配”的布尔标记，明文一律不在
  assert.equal(guanhuo.settings.turnstileSecretConfigured, true);
  assert.equal(guanhuo.settings.notifyWebhookConfigured, true);
  assert.equal(guanhuo.settings.adminUserIdConfigured, true);

  const text = JSON.stringify(backup);
  for (const secret of [
    "hashhashhashhashhashhashhashhash",
    "anotherhashhashhashhashhashhash",
    "session-dummy",
    "session-other",
    "turnstile-secret-xxx",
    "webhook-sign-secret-xxx",
    "token-xxx",
    "6541960132",
  ]) {
    assert.ok(!text.includes(secret), `备份里不应出现敏感值：${secret.slice(0, 8)}…`);
  }
  for (const key of ["apiId", "apiHash", "api_id", "api_hash", "session", "turnstileSecretKey", "notifyWebhookSecret", "notifyWebhook", "adminUserId"]) {
    assert.ok(!text.includes(`"${key}"`), `备份里不应出现字段 ${key}`);
  }

  const yanneo = backup.accounts.find((a) => a.id === "yanneo20");
  assert.ok(yanneo, "应有 yanneo20");
  assert.equal(yanneo.tasks.length, 1);
  assert.equal(yanneo.tasks[0].name, "宸宇签到");
});

test("备份导出：导出的任务能直接喂给导入接口（恢复路径不断）", async () => {
  const db = new DatabaseSync(":memory:");
  seed(db);
  const service = makeService(db);

  const backup = (await service.buildBackup()) as unknown as Backup;
  const guanhuo = backup.accounts.find((a) => a.id === "guanhuo03");
  assert.ok(guanhuo);
  // 先清掉原任务，模拟空库恢复
  db.prepare("DELETE FROM tasks WHERE account_id = ?").run("guanhuo03");
  const res = await service.fetch(
    new Request("http://localhost/tasks/import?account=guanhuo03", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tasks: guanhuo.tasks }),
    }),
  );
  assert.equal(res.status, 200);
  const data = (await res.json()) as { created?: number };
  assert.equal(data.created, 1, "备份里的任务应能原样导入恢复");
});
