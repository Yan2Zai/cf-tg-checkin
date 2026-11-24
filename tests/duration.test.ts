/** 每任务耗时：取每任务最近一条执行日志的 durationMs（日志按 id 倒序，最先见到的就是最新一次） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { lastDurationsByTask } from "../src/agent.ts";
import type { LogEntry } from "../src/types.ts";

const log = (over: Partial<LogEntry>): LogEntry => ({
  id: 1,
  taskId: 1,
  taskName: "示例任务",
  at: 1000,
  ok: true,
  level: "info",
  message: "签到成功",
  detail: null,
  source: "auto",
  ...over,
});

test("lastDurationsByTask：每任务只取最新一条日志的耗时，没有耗时不记", () => {
  const byTask = lastDurationsByTask([
    log({ id: 3, taskId: 1, durationMs: 1200 }),
    log({ id: 2, taskId: 1, durationMs: 9999 }),
    log({ id: 1, taskId: 2, durationMs: null }),
    log({ id: 4, taskId: 3, durationMs: 0 }),
  ]);
  assert.equal(byTask.get(1), 1200);
  assert.equal(byTask.has(2), false);
  assert.equal(byTask.get(3), 0);
});

test("lastDurationsByTask：系统日志（taskId 为空）不进结果", () => {
  const byTask = lastDurationsByTask([log({ id: 1, taskId: null, durationMs: 500 })]);
  assert.equal(byTask.size, 0);
});
