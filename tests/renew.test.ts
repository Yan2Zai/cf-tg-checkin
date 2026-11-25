/** 续费解析：余额 / 剩余天数 / 定胜负 / 成本 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  parseBalance,
  parseRenewState,
  beijingDate,
  classifyRenewReply,
  renewalCost,
  needsConfirm,
  runRenewal,
} from "../src/renew.ts";
import type { Task } from "../src/types.ts";

/* ---------- runRenewal：复用同轮 myinfo 回复 + 读不到余额时带剩余天数 ---------- */

/** 假 client：发 /myinfo 就回给定的正文，其它消息记下来 */
function renewClient(infoReply: string, sentLog: string[]) {
  const history: Array<{ id: number; out: boolean; message: string }> = [
    { id: 100, out: false, message: "旧消息" },
  ];
  let nextId = 101;
  return {
    async getEntity() {
      return { id: 1, username: "example_bot", className: "User", bot: true };
    },
    async getMessages() {
      return history.slice();
    },
    async sendMessage(_entity: unknown, params: { message: string }) {
      sentLog.push(params.message);
      const id = nextId++;
      history.push({ id, out: true, message: params.message });
      if (params.message === "/myinfo" || params.message === "/profile") {
        history.push({ id: nextId++, out: false, message: infoReply });
      }
      return { id };
    },
    async invoke() {
      return { message: "" };
    },
    async getInputEntity() {
      return { id: 1 };
    },
    async deleteMessages() {
      return undefined;
    },
    get connected() {
      return true;
    },
  };
}

function renewTask(): Task {
  return {
    id: 1,
    name: "示例任务",
    enabled: true,
    target: { kind: "user", id: "1", username: "example_bot", peerKind: "bot" },
    threadId: null,
    schedule: { kind: "daily", time: "09:30", jitterSeconds: 0 },
    steps: [{ type: "text", text: "/start" }],
    successKeywords: [],
    timeoutSeconds: 5,
    stepDelaySeconds: 0,
    deleteAfterSeconds: 0,
    cleanupPrevious: false,
    source: "ui",
    nextRunAt: null,
    lastRunAt: null,
    lastResult: null,
    lastMessage: null,
    createdAt: 0,
    updatedAt: 0,
    renewal: { enabled: true, button: "积分续期30天", minBalance: 400, infoCommand: "/myinfo" },
  } as Task;
}

const renewDeps = {
  store: { getKv: async () => null, setKv: async () => undefined },
  hooks: { log: () => undefined },
  pollIntervalMs: 50,
  stepWaitMs: 400,
  timezone: 8,
} as const;

test("runRenewal：复用同轮 myinfo 回复时不再重发 /myinfo", async () => {
  const sent: string[] = [];
  const client = renewClient("积分余额：100\n到期时间 2027-02-14", sent);
  const result = await runRenewal(
    client as never,
    renewTask(),
    renewDeps as never,
    "积分余额：100\n到期时间 2027-02-14",
  );
  assert.equal(result.outcome, "balance-below-threshold");
  assert.ok(!sent.includes("/myinfo"), "复用已有余额时不该再发 /myinfo");
});

test("runRenewal：没传复用回复时照旧现读 /myinfo", async () => {
  const sent: string[] = [];
  const client = renewClient("积分余额：100\n到期时间 2027-02-14", sent);
  const result = await runRenewal(client as never, renewTask(), renewDeps as never);
  assert.equal(result.outcome, "balance-below-threshold");
  assert.ok(sent.includes("/myinfo"), "没有复用回复时必须现读 /myinfo");
});

test("runRenewal：复用回复里读不到余额时回退到现读", async () => {
  const sent: string[] = [];
  const client = renewClient("积分余额：100\n到期时间 2027-02-14", sent);
  const result = await runRenewal(client as never, renewTask(), renewDeps as never, "签到中...");
  assert.equal(result.outcome, "balance-below-threshold");
  assert.ok(sent.includes("/myinfo"), "复用回复只是回调文本、没有余额时必须现读");
});

test("runRenewal：读不到余额时结果里带剩余天数，供预警用", async () => {
  const sent: string[] = [];
  const infoReply = "到期时间 2027-02-14\n签到成功";
  const client = renewClient(infoReply, sent);
  const result = await runRenewal(client as never, renewTask(), renewDeps as never);
  assert.equal(result.outcome, "no-balance-found");
  assert.equal(result.daysLeft, parseRenewState(infoReply).days);
});

test("parseBalance：三种余额写法都认", () => {
  assert.equal(parseBalance("积分余额：1234\n有效期至 2027-01-01"), 1234);
  assert.equal(parseBalance("持有积分 | 567"), 567);
  assert.equal(parseBalance("持有积分｜89"), 89);
  assert.equal(parseBalance("💰 yanneo 的积分余额\n\n🪙 当前积分：1333"), 1333);
  assert.equal(parseBalance("签到成功，明天再来"), null);
});

test("parseRenewState：到期时间优先，缺了再用剩余天数", () => {
  assert.deepEqual(parseRenewState("到期时间 2027-02-14", "2027-02-14"), { days: 0, exp: "2027-02-14" });
  assert.deepEqual(parseRenewState("到期时间 2027-02-14", "2027-02-09"), { days: 5, exp: "2027-02-14" });
  assert.deepEqual(parseRenewState("剩余 5 天"), { days: 5, exp: null });
  assert.deepEqual(parseRenewState(""), { days: null, exp: null });
});

test("beijingDate：按时区偏移算日期", () => {
  // 2026-11-23 16:00 UTC = 11 月 24 日 00:00（UTC+8）
  assert.equal(beijingDate(Date.parse("2026-11-23T16:00:00Z"), 8), "2026-11-24");
  assert.equal(beijingDate(Date.parse("2026-11-23T15:59:00Z"), 8), "2026-11-23");
});

test("classifyRenewReply：成功/失败/含糊三分", () => {
  assert.equal(classifyRenewReply("续费成功，有效期至 2027-02-14"), "renewed");
  assert.equal(classifyRenewReply("已开通，欢迎使用"), "renewed");
  assert.equal(classifyRenewReply("余额不足，请充值"), "not-renewed");
  assert.equal(classifyRenewReply("操作失败，请重试"), "not-renewed");
  assert.equal(classifyRenewReply("请稍等"), "unclear");
  // 成功和失败字样同时出现时不瞎报
  assert.equal(classifyRenewReply("续费成功，但上次失败了"), "unclear");
});

test("renewalCost：按按钮文本取成本", () => {
  assert.equal(renewalCost("续费7天"), 700);
  assert.equal(renewalCost("周卡"), 699);
  assert.equal(renewalCost("账号续期"), 500);
  assert.equal(renewalCost("积分续期30天"), 400);
  assert.equal(renewalCost("未知按钮"), null);
});

test("needsConfirm：只有确认弹窗、没有成功字样时才要点确认", () => {
  assert.equal(needsConfirm("请确认续期"), true);
  assert.equal(needsConfirm("续费成功"), false);
  assert.equal(needsConfirm(""), false);
});
