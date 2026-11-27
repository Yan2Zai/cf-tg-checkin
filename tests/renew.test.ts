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
  syntheticTask,
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

test("runRenewal：menuPath 为空数组时发 /start 找按钮，不发 /shop", async () => {
  const sent: string[] = [];
  const client = renewClient("积分余额：100\n到期时间 2027-02-14", sent);
  const task = renewTask();
  task.renewal = { enabled: true, button: "积分续期", minBalance: 6, infoCommand: "/start", menuPath: [] };
  const result = await runRenewal(client as never, task, renewDeps as never, "积分余额：100\n到期时间 2027-02-14");
  assert.ok(sent.includes("/start"), "按钮在 /start 菜单上时该发 /start");
  assert.ok(!sent.includes("/shop"), "不该发不存在的 /shop");
  assert.notEqual(result.outcome, "renewed");
});

test("runRenewal：没配 menuPath 时照旧发 /shop", async () => {
  const sent: string[] = [];
  const client = renewClient("积分余额：1000\n到期时间 2027-02-14", sent);
  const result = await runRenewal(client as never, renewTask(), renewDeps as never, "积分余额：1000\n到期时间 2027-02-14");
  assert.ok(sent.includes("/shop"), "没配菜单路径时照旧发 /shop");
  assert.ok(!sent.includes("/start"), "不该发 /start");
  assert.notEqual(result.outcome, "renewed");
});

test("runRenewal：读不到余额时结果里带剩余天数，供预警用", async () => {
  const sent: string[] = [];
  const infoReply = "到期时间 2027-02-14\n签到成功";
  const client = renewClient(infoReply, sent);
  const result = await runRenewal(client as never, renewTask(), renewDeps as never);
  assert.equal(result.outcome, "no-balance-found");
  assert.equal(result.daysLeft, parseRenewState(infoReply).days);
});

test("runRenewal：现读余额时结果里带 infoReply，复用时不带", async () => {
  const sent: string[] = [];
  const infoReply = "积分余额：100\n到期时间 2027-02-14";
  const client = renewClient(infoReply, sent);
  const fresh = await runRenewal(client as never, renewTask(), renewDeps as never);
  assert.equal(fresh.outcome, "balance-below-threshold");
  assert.equal(fresh.infoReply, infoReply, "现读到的信息回复应随结果带回，供面板补 myinfoReply");

  const reused = await runRenewal(client as never, renewTask(), renewDeps as never, infoReply);
  assert.equal(reused.outcome, "balance-below-threshold");
  assert.equal(reused.infoReply, undefined, "复用已有回复时不用再带 infoReply");
});

/** 假 client：发 /myinfo 回余额，发 /shop 回带续费按钮的菜单，点按钮只回空弹窗 */
function renewClientWithShopButton(infoReply: string, sentLog: string[], buttonText: string) {
  const history: Array<{ id: number; out: boolean; message: string; replyMarkup?: unknown }> = [
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
      if (params.message === "/shop") {
        history.push({
          id: nextId++,
          out: false,
          message: "请选择操作",
          replyMarkup: { rows: [{ buttons: [{ text: buttonText, data: Buffer.from("x") }] }] },
        });
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

test("runRenewal：点击含糊时不再重读 /myinfo，直接报 click-sent-unclear", async () => {
  const sent: string[] = [];
  const client = renewClientWithShopButton("积分余额：1000\n到期时间 2027-02-14", sent, "积分续期30天");
  const result = await runRenewal(client as never, renewTask(), renewDeps as never);
  assert.equal(result.outcome, "click-sent-unclear");
  assert.equal(sent.filter((m) => m === "/myinfo").length, 1, "含糊时不该为核验再发一次 /myinfo");
  assert.ok(sent.includes("/shop"), "找按钮时照旧发 /shop");
});

/* ---------- 续费成功后重读信息命令 + 合成任务步间等待 ---------- */

/**
 * 假 client：续费全流程走通——/myinfo 按调用顺序依次回给定的回复
 * （不复用时第一次是续费前余额、第二次是续费后余额；复用时只有重读那一次）；
 * /shop 回带续费按钮的菜单；点按钮后弹窗回「续费成功」并补发一条文字结果。
 */
function renewClientWithRenewalSuccess(
  infoReplies: Array<string | null>,
  sentLog: string[],
  buttonText: string,
) {
  const history: Array<{ id: number; out: boolean; message: string; replyMarkup?: unknown }> = [
    { id: 100, out: false, message: "旧消息" },
  ];
  let nextId = 101;
  let infoCalls = 0;
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
        const reply = infoReplies[infoCalls] ?? null;
        infoCalls++;
        if (reply !== null) history.push({ id: nextId++, out: false, message: reply });
      }
      if (params.message === "/shop") {
        history.push({
          id: nextId++,
          out: false,
          message: "请选择操作",
          replyMarkup: { rows: [{ buttons: [{ text: buttonText, data: Buffer.from("x") }] }] },
        });
      }
      return { id };
    },
    async invoke() {
      history.push({ id: nextId++, out: false, message: "续费成功，有效期至 2027-03-16" });
      return { message: "续费成功，有效期至 2027-03-16" };
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

test("runRenewal：续费成功后重读一次 /myinfo，面板拿到续费后的余额与有效期", async () => {
  const sent: string[] = [];
  const before = "积分余额：1000\n到期时间 2027-02-14";
  const after = "积分余额：900\n到期时间 2027-03-16";
  const client = renewClientWithRenewalSuccess([before, after], sent, "积分续期30天");
  const result = await runRenewal(client as never, renewTask(), renewDeps as never);
  assert.equal(result.outcome, "renewed");
  assert.equal(result.infoReply, after, "续费成功后应重读一次信息命令，带回续费后的余额与有效期");
  assert.equal(sent.filter((m) => m === "/myinfo").length, 2, "续费前查一次余额，续费成功后再读一次新鲜数据");
  assert.equal(sent.filter((m) => m === "/shop").length, 1, "机器人及时回菜单时不该重发 /shop");
});

test("runRenewal：复用同轮回复查余额时，续费成功后仍重读一次取新鲜数据", async () => {
  const sent: string[] = [];
  const before = "积分余额：1000\n到期时间 2027-02-14";
  const after = "积分余额：900\n到期时间 2027-03-16";
  const client = renewClientWithRenewalSuccess([after], sent, "积分续期30天");
  const result = await runRenewal(client as never, renewTask(), renewDeps as never, before);
  assert.equal(result.outcome, "renewed");
  assert.equal(result.infoReply, after, "复用回复只够查余额，续费后的新鲜数据仍要重读一次");
  assert.equal(sent.filter((m) => m === "/myinfo").length, 1, "复用时续费前不发 /myinfo，只发续费后重读的那一次");
});

test("runRenewal：续费成功后重读不到余额时，保留续费前的回复", async () => {
  const sent: string[] = [];
  const before = "积分余额：1000\n到期时间 2027-02-14";
  const client = renewClientWithRenewalSuccess([before, "请稍等，正在查询……"], sent, "积分续期30天");
  const result = await runRenewal(client as never, renewTask(), renewDeps as never);
  assert.equal(result.outcome, "renewed");
  assert.equal(result.infoReply, before, "重读不到余额时保留续费前的信息回复，不要拿无余额的回复顶掉它");
  assert.equal(sent.filter((m) => m === "/myinfo").length, 2);
});

test("syntheticTask：步间等待继承原任务、保底 5 秒", () => {
  const task = renewTask();
  task.stepDelaySeconds = 15;
  assert.equal(syntheticTask(task, [], []).stepDelaySeconds, 15, "原任务等 15 秒的，续费合成任务也等 15 秒");
  task.stepDelaySeconds = 1;
  assert.equal(syntheticTask(task, [], []).stepDelaySeconds, 5, "步间等待不足 5 秒时保底 5 秒");
  task.stepDelaySeconds = 0;
  assert.equal(syntheticTask(task, [], []).stepDelaySeconds, 5);
  task.stepDelaySeconds = undefined as never;
  assert.equal(syntheticTask(task, [], []).stepDelaySeconds, 5, "没配步间等待时保底 5 秒");
});

test("parseBalance：标签锚定，各种余额写法都认", () => {
  // 已见过的真实回复格式
  assert.equal(parseBalance("积分余额：1234\n有效期至 2027-01-01"), 1234);
  assert.equal(parseBalance("持有积分 | 567"), 567);
  assert.equal(parseBalance("持有积分｜89"), 89);
  assert.equal(parseBalance("💰 yanneo 的积分余额\n\n🪙 当前积分：1333"), 1333);
  assert.equal(parseBalance("🍒 积分 | 2"), 2);
  assert.equal(parseBalance("今天已经签过到了，明天再来～ 当前积分 2"), 2);
  assert.equal(parseBalance("🏪 积分商城\n💰 你的余额：1333 积分"), 1333);
  // 其它标签写法
  assert.equal(parseBalance("剩余积分：42"), 42);
  assert.equal(parseBalance("我的积分 7"), 7);
  assert.equal(parseBalance("可用积分｜15"), 15);
  // 反例：增量、日期、无关数字都不认
  assert.equal(parseBalance("签到成功，明天再来"), null);
  assert.equal(parseBalance("签到成功，积分 +5"), null);
  assert.equal(parseBalance("⏰ 到期时间 | 2028-10-13（剩 687 天）"), null);
  assert.equal(parseBalance("🎫 注册名额 | 总上限 100 | 已注册 93 | 可注册 7"), null);
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
  assert.equal(renewalCost("账号续期30天"), 666);
  assert.equal(renewalCost("账号续期"), 500);
  assert.equal(renewalCost("积分续期30天"), 400);
  assert.equal(renewalCost("未知按钮"), null);
});

test("needsConfirm：只有确认弹窗、没有成功字样时才要点确认", () => {
  assert.equal(needsConfirm("请确认续期"), true);
  assert.equal(needsConfirm("续费成功"), false);
  assert.equal(needsConfirm(""), false);
});
