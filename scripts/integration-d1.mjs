#!/usr/bin/env node
/**
 * D1 版端到端集成测试：真的起一个 `wrangler dev --config wrangler.d1.jsonc --local`
 *（本地 D1 + 独立持久化目录 + 独立端口），用 HTTP 打完整的 Worker → D1 链路。
 *
 * 与 DO 版集成测试（scripts/integration.mjs）的区别：
 *  - 不读 DO 内嵌 SQLite：断言改走 D1（本地用 `wrangler d1 execute --local` 查表）
 *  - 多账号：建账号、切账号、账号隔离
 *  - /api/tick：机器认证（x-admin-password）+ 分批返回 { ran, remaining, nextRunAt }
 *
 * 用法：node scripts/integration-d1.mjs [--verbose]
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// 版本号只有一个来源：package.json（别手写，bump 后集成测试自动跟上）
const EXPECTED_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const verbose = process.argv.includes("--verbose");
const PORT = 8800 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "it-password-d1-7c2e";
const persistDir = mkdtempSync(join(tmpdir(), "cf-tg-it-d1-"));

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    if (verbose) console.log(`  ✓ ${name}`);
    return;
  }
  failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
  console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ""}`);
}

/** 本地 D1 里跑一条 SQL，返回行数组（wrangler d1 execute --local --json）。 */
function d1Query(sql) {
  const out = execFileSync(
    join(process.cwd(), "node_modules", ".bin", "wrangler"),
    [
      "d1",
      "execute",
      "cf-tg-checkin-d1",
      "--config",
      "wrangler.d1.jsonc",
      "--local",
      "--persist-to",
      persistDir,
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
  const parsed = JSON.parse(out);
  return parsed?.[0]?.results ?? [];
}

async function main() {
  console.log(`D1 集成测试：起 wrangler dev（端口 ${PORT}，持久化 ${persistDir}）`);
  const wranglerBin = join(process.cwd(), "node_modules", ".bin", "wrangler");
  if (!existsSync(wranglerBin)) throw new Error("找不到 wrangler，先跑 npm install");

  // 先把迁移应用到本地 D1（Worker 本身不建表）
  execFileSync(
    wranglerBin,
    [
      "d1",
      "execute",
      "cf-tg-checkin-d1",
      "--config",
      "wrangler.d1.jsonc",
      "--local",
      "--persist-to",
      persistDir,
      "--file",
      "migrations/0001_init.sql",
    ],
    { stdio: verbose ? "inherit" : "ignore", env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" } },
  );
  const tables = d1Query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map((r) => r.name);
  check("迁移建出 8 张业务表", ["accounts", "auth_attempts", "deletions", "events", "kv", "locks", "logs", "tasks"].every((t) => tables.includes(t)), tables.join(","));

  const child = spawn(
    wranglerBin,
    [
      "dev",
      "--config",
      "wrangler.d1.jsonc",
      "--local",
      "--port",
      String(PORT),
      "--ip",
      "127.0.0.1",
      "--var",
      `ADMIN_PASSWORD:${PASSWORD}`,
      "--persist-to",
      persistDir,
    ],
    {
      stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
      detached: true,
    },
  );

  const logs = [];
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
  };
  process.on("exit", stop);

  const watchdog = setTimeout(() => {
    console.error("\n✗ D1 集成测试超时（180s），已中止");
    console.error(logs.join("").slice(-2000));
    stop();
    process.exit(1);
  }, 180_000);
  watchdog.unref();

  try {
    await waitForServer(logs, stop);

    // ---------- 未登录 ----------
    let res = await fetch(`${BASE}/api/state`);
    check("未登录访问 /api/state 返回 401", res.status === 401, `status=${res.status}`);

    res = await fetch(`${BASE}/api/accounts`);
    check("未登录访问 /api/accounts 返回 401", res.status === 401, `status=${res.status}`);

    // ---------- 登录 ----------
    res = await post("/api/login", { password: "wrong" });
    check("错误口令返回 401", res.status === 401, `status=${res.status}`);

    res = await post("/api/login", { password: PASSWORD });
    const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
    check("登录成功并下发 Cookie", res.status === 200 && cookie.startsWith("tg_checkin=v1."), `cookie=${cookie.slice(0, 12)}…`);

    // ---------- 账号 ----------
    let accounts = await get("/api/accounts");
    check("初始账号列表为空", Array.isArray(accounts.accounts) && accounts.accounts.length === 0, JSON.stringify(accounts.accounts));

    const badId = await post("/api/accounts", { id: "Bad_ID!" });
    check("非法账号 id 被拒（400）", badId.status === 400, `status=${badId.status}`);

    const createdA = await post("/api/accounts", { id: "test-a", label: "测试账号 A" });
    check("创建账号 test-a", createdA.status === 200 && createdA.account?.id === "test-a", JSON.stringify(createdA.account));
    const createdB = await post("/api/accounts", { id: "test-b" });
    check("创建账号 test-b（无展示名）", createdB.status === 200 && createdB.account?.id === "test-b");

    accounts = await get("/api/accounts");
    check("账号列表有 2 个", accounts.accounts?.length === 2, `got ${accounts.accounts?.length}`);
    const rows = d1Query("SELECT id, label, enabled FROM accounts ORDER BY id");
    check("D1 的 accounts 表里有 2 行", rows.length === 2 && rows[0].id === "test-a" && rows[1].id === "test-b", JSON.stringify(rows));

    const dup = await post("/api/accounts", { id: "test-a" });
    check("重复建账号被拒", dup.status !== 200, `status=${dup.status}`);

    const disabled = await post("/api/accounts/test-b/enable", { enabled: false });
    check("停用账号", disabled.status === 200 && disabled.account?.enabled === false, JSON.stringify(disabled.account));
    const reenabled = await post("/api/accounts/test-b/enable", { enabled: true });
    check("重新启用账号", reenabled.account?.enabled === true);

    // ---------- 初始状态（带账号参数） ----------
    const state = await get("/api/state?account=test-a");
    check("/api/state?account=test-a 返回 settings / tasks", !!state.settings && Array.isArray(state.tasks));
    check("空壳状态下任务为空", state.tasks.length === 0);

    // ---------- 建任务（账号隔离） ----------
    const taskInput = {
      name: "集成-账号隔离",
      enabled: true,
      target: { kind: "user", id: "a_bot", username: "a_bot" },
      schedule: { kind: "daily", time: "08:15" },
      steps: [{ type: "text", text: "签到" }],
      successKeywords: [],
      timeoutSeconds: 30,
      stepDelaySeconds: 3,
      deleteAfterSeconds: 0,
      cleanupPrevious: true,
      source: "ui",
    };
    const created = await post("/api/tasks?account=test-a", taskInput);
    check("在 test-a 建任务", created.status === 200 && created.task?.id, `status=${created.status}`);
    const stateA = await get("/api/state?account=test-a");
    const stateB = await get("/api/state?account=test-b");
    check("test-a 能看到任务，test-b 看不到（隔离）", stateA.tasks.length === 1 && stateB.tasks.length === 0, `a=${stateA.tasks.length} b=${stateB.tasks.length}`);
    const taskRows = d1Query("SELECT account_id FROM tasks");
    check("D1 的 tasks 行带 account_id=test-a", taskRows.length === 1 && taskRows[0].account_id === "test-a", JSON.stringify(taskRows));

    // ---------- /api/tick（机器认证 + 分批返回） ----------
    const tickNoAuth = await fetch(`${BASE}/api/tick?limit=5`, { method: "POST" });
    check("没带机器口令调 /api/tick 返回 401", tickNoAuth.status === 401, `status=${tickNoAuth.status}`);
    const tickWrong = await fetch(`${BASE}/api/tick?limit=5`, {
      method: "POST",
      headers: { "x-admin-password": "wrong-password" },
    });
    check("机器口令错误调 /api/tick 返回 401", tickWrong.status === 401, `status=${tickWrong.status}`);
    const tick = await fetch(`${BASE}/api/tick?limit=5`, {
      method: "POST",
      headers: { "x-admin-password": PASSWORD },
    });
    const tickData = await tick.json();
    check(
      "机器认证调 /api/tick 成功，分批返回 remaining: 0",
      tick.status === 200 && tickData.ok === true && tickData.locked === true && Array.isArray(tickData.ran) && tickData.remaining === 0,
      JSON.stringify(tickData),
    );
    check(
      "tick 返回 queriesUsed（本调用实际用的 D1 查询数）",
      typeof tickData.queriesUsed === "number" && tickData.queriesUsed >= 0 && tickData.queriesUsed <= 45,
      JSON.stringify(tickData.queriesUsed),
    );
    // 再调两次，空壳每次都应返回 remaining: 0
    for (let i = 0; i < 2; i++) {
      const again = await fetch(`${BASE}/api/tick?limit=5`, {
        method: "POST",
        headers: { "x-admin-password": PASSWORD },
      });
      const againData = await again.json();
      check(`第 ${i + 2} 次 /api/tick 仍返回 remaining: 0`, again.status === 200 && againData.remaining === 0, JSON.stringify(againData));
    }

    // ---------- 备份导出（机器认证 + 脱敏） ----------
    const backupNoAuth = await fetch(`${BASE}/api/backup`);
    check("没带机器口令调 /api/backup 返回 401", backupNoAuth.status === 401, `status=${backupNoAuth.status}`);
    const backupWrong = await fetch(`${BASE}/api/backup`, { headers: { "x-admin-password": "wrong-password" } });
    check("机器口令错误调 /api/backup 返回 401", backupWrong.status === 401, `status=${backupWrong.status}`);
    const backupRes = await fetch(`${BASE}/api/backup`, { headers: { "x-admin-password": PASSWORD } });
    const backup = await backupRes.json();
    const backupText = JSON.stringify(backup);
    check(
      "机器认证调 /api/backup 成功，含两账号的任务",
      backupRes.status === 200 &&
        backup.format === "cf-tg-checkin.d1-backup" &&
        backup.version === 1 &&
        backup.accounts?.length === 2 &&
        backup.accounts.find((a) => a.id === "test-a")?.tasks?.length === 1 &&
        backup.accounts.find((a) => a.id === "test-a")?.tasks[0]?.name === "集成-账号隔离",
      backupText.slice(0, 300),
    );
    check(
      "备份里没有敏感字段（apiId / apiHash / session / 密钥原文）",
      !backupText.includes('"apiHash"') &&
        !backupText.includes('"api_id"') &&
        !backupText.includes('"turnstileSecretKey"') &&
        !backupText.includes('"notifyWebhookSecret"') &&
        !backup.accounts.some((a) => "session" in a),
      backupText.slice(0, 300),
    );

    // ---------- run-summary（机器认证，供每日健康盯守用） ----------
    const summaryNoAuth = await fetch(`${BASE}/api/run-summary`);
    check("没带机器口令调 /api/run-summary 返回 401", summaryNoAuth.status === 401, `status=${summaryNoAuth.status}`);
    const summaryRes = await fetch(`${BASE}/api/run-summary`, { headers: { "x-admin-password": PASSWORD } });
    const summaryData = await summaryRes.json();
    check(
      "机器认证调 /api/run-summary 成功（没跑过时 summary 为 null）",
      summaryRes.status === 200 && "summary" in summaryData && summaryData.summary === null,
      JSON.stringify(summaryData).slice(0, 200),
    );

    // ---------- 失败任务重跑（上一轮没有汇总时返回空列表，不报错） ----------
    const retryNoAuth = await fetch(`${BASE}/api/retry-failed`, { method: "POST" });
    check("没登录调 /api/retry-failed 返回 401", retryNoAuth.status === 401, `status=${retryNoAuth.status}`);
    const retryEmpty = await post("/api/retry-failed", {});
    check(
      "上一轮没有汇总时 /api/retry-failed 返回空列表",
      retryEmpty.status === 200 &&
        retryEmpty.ok === true &&
        Array.isArray(retryEmpty.retried) &&
        retryEmpty.retried.length === 0 &&
        Array.isArray(retryEmpty.skippedBB),
      JSON.stringify(retryEmpty).slice(0, 200),
    );

    // ---------- 导出 / 导入 ----------
    const exported = await get("/api/tasks/export?account=test-a");
    check("导出包含 test-a 的任务", exported.tasks?.length === 1 && exported.tasks[0].name === "集成-账号隔离", JSON.stringify(exported.tasks?.length));
    const imported = await post("/api/tasks/import?account=test-b", { tasks: exported.tasks });
    check("把 test-a 的任务导入 test-b", imported.created === 1, JSON.stringify(imported));
    const stateB2 = await get("/api/state?account=test-b");
    check("test-b 导入后有 1 个任务", stateB2.tasks.length === 1, `got ${stateB2.tasks.length}`);

    // ---------- 锁表 ----------
    const lockRows = d1Query("SELECT COUNT(*) AS n FROM locks");
    check("tick 跑完后 locks 表为空（锁已释放）", lockRows[0]?.n === 0, JSON.stringify(lockRows));

    // ---------- 安全头 ----------
    res = await fetch(`${BASE}/api/version`);
    check("API 响应带 no-store 与 HSTS", res.headers.get("cache-control") === "no-store" && !!res.headers.get("strict-transport-security"));
    const version = await res.json();
    check(`版本号是 ${EXPECTED_VERSION}（package.json）`, version.version === EXPECTED_VERSION, JSON.stringify(version.version));

    // ---------- 登出 ----------
    res = await post("/api/logout", {});
    check("登出返回 200", res.status === 200);
  } finally {
    stop();
    rmSync(persistDir, { recursive: true, force: true });
  }

  clearTimeout(watchdog);
  console.log(`\n${failures.length ? "✗" : "✓"} ${passed} 项通过${failures.length ? ` / ${failures.length} 项失败` : ""}`);
  if (failures.length) {
    console.log(failures.map((item) => `  · ${item}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

/* ------------------------------------------------------------------ 工具 */

let cookieJar = "";

async function request(method, path, body, extraHeaders = {}) {
  const headers = { accept: "application/json", ...(extraHeaders.origin ? { origin: extraHeaders.origin } : {}) };
  if (cookieJar) headers.cookie = cookieJar;
  const init = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookieJar = setCookie.split(";")[0];
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 200) };
  }
  return {
    status: res.status,
    headers: res.headers,
    ...(data && typeof data === "object" ? data : {}),
    _raw: data,
  };
}

async function get(path) {
  return request("GET", path);
}

async function post(path, body, extraHeaders = {}) {
  return request("POST", path, body, extraHeaders);
}

async function waitForServer(logs, stop) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/version`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  stop();
  throw new Error(`wrangler dev 没能在 90s 内启动：\n${logs.join("").slice(-2000)}`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
