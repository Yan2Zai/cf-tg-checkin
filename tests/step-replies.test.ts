/**
 * 执行器：按步骤归属回复（修 myinfo 回执重复 bug）。
 *
 * 场景：/start → 点「签到」（只有弹窗回调 "✔️ Done!"）→ /myinfo。
 * 签到步的回复必须是弹窗回调，myinfo 步的回复必须是 myinfo 正文，两者不能相同。
 * 之前执行器只抓最后一步的回复，签到回复和 myinfo 回复在库里就是同一条。
 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import { executeTask } from "../src/telegram/executor.ts";
import { resolveTaskReplies } from "../src/agent.ts";
import type { Task } from "../src/types.ts";

const MYINFO_TEXT = "积分 1109\n有效期至 2026-11-28";
const MENU_TEXT = "请选择要签到的账号";

/**
 * 假 client：模拟真实时序。
 * - 发 /start → 机器人回带「签到」按钮的菜单（#103）
 * - 点「签到」→ 只有 callback 弹窗 "✔️ Done!"，不发新消息
 * - 发 /myinfo → 机器人回 myinfo 正文（#105）
 */
function stepRepliesClient() {
  const history: Array<{ id: number; out: boolean; message: string; replyMarkup?: unknown }> = [
    { id: 100, out: false, message: "旧消息" },
  ];
  return {
    logs: [] as string[],
    async getMessages() {
      return history.slice();
    },
    async sendMessage(_entity: unknown, params: { message: string }) {
      if (params.message === "/start") {
        history.push({ id: 102, out: true, message: "/start" });
        history.push({
          id: 103,
          out: false,
          message: MENU_TEXT,
          replyMarkup: { rows: [{ buttons: [{ text: "签到", data: Buffer.from([1]) }] }] },
        });
        return { id: 102 };
      }
      if (params.message === "/myinfo") {
        history.push({ id: 104, out: true, message: "/myinfo" });
        history.push({ id: 105, out: false, message: MYINFO_TEXT });
        return { id: 104 };
      }
      history.push({ id: 106, out: true, message: params.message });
      return { id: 106 };
    },
    async invoke() {
      return { message: "✔️ Done!" };
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

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: 1,
    name: "测试任务",
    enabled: true,
    target: { kind: "user", id: "1", username: "bot", peerKind: "bot" },
    threadId: null,
    schedule: { kind: "daily", time: "09:30", jitterSeconds: 0 },
    steps: [{ type: "text", text: "/start" }, { type: "click", text: "签到" }, { type: "text", text: "/myinfo" }],
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
    ...over,
  } as Task;
}

test("执行器：每步的回复按步骤归属，签到步取弹窗回调、myinfo 步取正文", async () => {
  const client = stepRepliesClient();
  const outcome = await executeTask(client as never, makeTask(), {
    entity: { id: 1, username: "bot", className: "User", bot: true } as never,
    hooks: { log: () => undefined },
    pollIntervalMs: 100,
    stepWaitMs: 400,
  });
  assert.equal(outcome.ok, true);
  // stepReplies 与 steps 一一对应
  assert.equal(outcome.stepReplies?.length, 3);
  assert.equal(outcome.stepReplies[0], MENU_TEXT, "/start 步的回复是菜单");
  assert.equal(outcome.stepReplies[1], "✔️ Done!", "点签到步的回复是弹窗回调");
  assert.equal(outcome.stepReplies[2], MYINFO_TEXT, "/myinfo 步的回复是 myinfo 正文");
  assert.notEqual(outcome.stepReplies[1], outcome.stepReplies[2], "签到回复和 myinfo 回复不能相同");
  // 只有弹窗回调、没有正文回复的步骤要标出来（薄回调假成功用它区分）
  assert.deepEqual(outcome.stepCallbackOnly, [false, true, false]);
  // allReplies 不能只反映最后一步
  assert.ok(outcome.allReplies.includes("✔️ Done!"), "allReplies 要含签到步的回调");
  assert.ok(outcome.allReplies.includes(MYINFO_TEXT), "allReplies 要含 myinfo 正文");
  // 最后一步的回复（续费 / 面板 myinfo 用）保持不变
  assert.equal(outcome.replyFullText, MYINFO_TEXT);
});

test("执行器：点完只有弹窗回调时不等新菜单（不白等 stepWait）", async () => {
  const client = stepRepliesClient();
  const logs: string[] = [];
  const started = Date.now();
  const outcome = await executeTask(client as never, makeTask(), {
    entity: { id: 1, username: "bot", className: "User", bot: true } as never,
    hooks: { log: (_level, message) => { logs.push(message); } },
    pollIntervalMs: 100,
    // stepWait 拉到 15s：如果代码在等新菜单会等满 15s；补抓后续文字只等 5s，两者能区分
    stepWaitMs: 15000,
  });
  assert.equal(outcome.ok, true);
  assert.ok(
    !logs.some((line) => line.includes("没有等到新的按钮菜单")),
    "只有弹窗回调时不该等新菜单、不该报超时警告",
  );
  // 补抓后续文字最多等 5s，加上其余步骤的开销也不该到 8s；等新菜单会等满 15s
  assert.ok(Date.now() - started < 8000, `点完有回调只补抓后续文字，不该等满 15s，实际 ${Date.now() - started}ms`);
});

/* ---------- resolveTaskReplies：签到回复与 myinfo 回复的拆分 ---------- */

const STEPS = [
  { type: "text", text: "/start" },
  { type: "click", text: "签到" },
  { type: "text", text: "/myinfo" },
] as Task["steps"];

test("拆回复：签到回复取签到步的回调，myinfo 回复取最后一步", () => {
  const { reply, myinfoReply, signInCallbackOnly } = resolveTaskReplies(STEPS, {
    replyText: MYINFO_TEXT,
    replyFullText: MYINFO_TEXT,
    allReplies: [MENU_TEXT, "✔️ Done!", MYINFO_TEXT],
    stepReplies: [MENU_TEXT, "✔️ Done!", MYINFO_TEXT],
    stepCallbackOnly: [false, true, false],
  });
  assert.equal(reply, "✔️ Done!");
  assert.equal(myinfoReply, MYINFO_TEXT);
  assert.notEqual(reply, myinfoReply);
  assert.equal(signInCallbackOnly, true, "签到步的回复只来自弹窗回调时要标出来");
});

test("拆回复：签到步拿到正文回复时不标仅回调", () => {
  const { reply, signInCallbackOnly } = resolveTaskReplies(STEPS, {
    replyText: MYINFO_TEXT,
    replyFullText: MYINFO_TEXT,
    allReplies: [MENU_TEXT, "签到成功", MYINFO_TEXT],
    stepReplies: [MENU_TEXT, "签到成功", MYINFO_TEXT],
    stepCallbackOnly: [false, false, false],
  });
  assert.equal(reply, "签到成功");
  assert.equal(signInCallbackOnly, false);
});

test("拆回复：信息步没抓到回复、myinfo 是回调兜底时标 myinfoCallbackOnly", () => {
  const { myinfoReply, myinfoCallbackOnly } = resolveTaskReplies(STEPS, {
    replyText: "签到中...",
    replyFullText: "签到中...",
    allReplies: [MENU_TEXT, "签到中..."],
    stepReplies: [MENU_TEXT, "签到中...", null],
    stepCallbackOnly: [false, true, false],
  });
  assert.equal(myinfoReply, "签到中...", "信息步没回复时 myinfo 从最终回复兜底来");
  assert.equal(myinfoCallbackOnly, true, "兜底来的只是弹窗回调，不是真的信息回复，要标出来供续费回写");

  const real = resolveTaskReplies(STEPS, {
    replyText: MYINFO_TEXT,
    replyFullText: MYINFO_TEXT,
    allReplies: [MENU_TEXT, "✔️ Done!", MYINFO_TEXT],
    stepReplies: [MENU_TEXT, "✔️ Done!", MYINFO_TEXT],
    stepCallbackOnly: [false, true, false],
  });
  assert.equal(real.myinfoReply, MYINFO_TEXT);
  assert.equal(real.myinfoCallbackOnly, false, "信息步抓到正文时不标");
});

test("拆回复：老数据没有 stepCallbackOnly 时默认不标", () => {
  const { signInCallbackOnly } = resolveTaskReplies(STEPS, {
    replyText: MYINFO_TEXT,
    replyFullText: MYINFO_TEXT,
    allReplies: [MENU_TEXT, "✔️ Done!", MYINFO_TEXT],
    stepReplies: [MENU_TEXT, "✔️ Done!", MYINFO_TEXT],
  });
  assert.equal(signInCallbackOnly, false);
});

test("拆回复：签到步没抓到回复时留空，不往前找关键词、不用 myinfo 顶", () => {
  const withKeyword = resolveTaskReplies(STEPS, {
    replyText: MYINFO_TEXT,
    replyFullText: MYINFO_TEXT,
    allReplies: ["签到成功！请选择", MYINFO_TEXT],
    stepReplies: ["签到成功！请选择", null, MYINFO_TEXT],
  });
  assert.equal(withKeyword.reply, "", "签到步没回复时留空，哪怕前面步骤含签到关键词");
  assert.equal(withKeyword.myinfoReply, MYINFO_TEXT);

  const withoutKeyword = resolveTaskReplies(STEPS, {
    replyText: MYINFO_TEXT,
    replyFullText: MYINFO_TEXT,
    allReplies: [MENU_TEXT, MYINFO_TEXT],
    stepReplies: [MENU_TEXT, null, MYINFO_TEXT],
  });
  assert.equal(withoutKeyword.reply, "", "没抓到签到回复时宁可留空，也别拿 myinfo 当签到回复");
  assert.equal(withoutKeyword.myinfoReply, MYINFO_TEXT);
});

test("拆回复：老数据（没有 stepReplies）且最后一步是追加指令时，签到回复留空", () => {
  const { reply, myinfoReply } = resolveTaskReplies(STEPS, {
    replyText: MYINFO_TEXT,
    replyFullText: MYINFO_TEXT,
    allReplies: [MYINFO_TEXT],
  });
  assert.equal(reply, "", "老数据里 allReplies 只有 myinfo 回复，不能当签到回复");
  assert.equal(myinfoReply, MYINFO_TEXT);
});

test("拆回复：老数据且最后一步不是追加指令时，沿用旧逻辑", () => {
  const steps = [
    { type: "text", text: "/start" },
    { type: "click", text: "签到" },
  ] as Task["steps"];
  const { reply, myinfoReply } = resolveTaskReplies(steps, {
    replyText: "✔️ Done!",
    replyFullText: "✔️ Done!",
    allReplies: ["✔️ Done!"],
  });
  assert.equal(reply, "✔️ Done!");
  assert.equal(myinfoReply, "");
});

test("拆回复：没有追加指令的新数据，签到回复取最后一步", () => {
  const steps = [
    { type: "text", text: "/start" },
    { type: "click", text: "签到" },
  ] as Task["steps"];
  const { reply, myinfoReply } = resolveTaskReplies(steps, {
    replyText: "✔️ Done!",
    replyFullText: "✔️ Done!",
    allReplies: [MENU_TEXT, "✔️ Done!"],
    stepReplies: [MENU_TEXT, "✔️ Done!"],
  });
  assert.equal(reply, "✔️ Done!");
  assert.equal(myinfoReply, "");
});

/* ---------- 慢回包：签到步的回复晚于 1 秒间隔到达 ---------- */

/**
 * 假 client：签到步的回包在发送后 1.5 秒才出现（步骤间隔只有 1 秒）。
 * 回包的消息 id（105）比下一步发出的 /myinfo（104）大——真实 Telegram 里
 * 晚到的消息就是这样排号的，所以只看 id 窗口会把它错归到 /myinfo 步。
 * 执行器必须在步骤间等待里多等一会儿、把它抓回签到步，而不是发完下一步才认。
 */
function slowReplyClient() {
  const started = Date.now();
  const revealAt = started + 1500;
  let revealed = false;
  const history: Array<{ id: number; out: boolean; message: string }> = [
    { id: 100, out: false, message: "旧消息" },
  ];
  const maybeReveal = () => {
    if (!revealed && Date.now() >= revealAt) {
      revealed = true;
      history.push({ id: 105, out: false, message: "签到成功" });
    }
  };
  return {
    async getMessages() {
      maybeReveal();
      return history.slice();
    },
    async sendMessage(_entity: unknown, params: { message: string }) {
      maybeReveal();
      if (params.message === "/start") {
        history.push({ id: 102, out: true, message: "/start" });
        return { id: 102 };
      }
      if (params.message === "/myinfo") {
        history.push({ id: 104, out: true, message: "/myinfo" });
        history.push({ id: 106, out: false, message: MYINFO_TEXT });
        return { id: 104 };
      }
      history.push({ id: 107, out: true, message: params.message });
      return { id: 107 };
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

test("执行器：签到步回包晚于 1 秒间隔时，仍归签到步、不串到 /myinfo 步", async () => {
  const client = slowReplyClient();
  const outcome = await executeTask(
    client as never,
    makeTask({
      steps: [{ type: "text", text: "/start" }, { type: "text", text: "/myinfo" }],
      stepDelaySeconds: 1,
      timeoutSeconds: 5,
    }),
    {
      entity: { id: 1, username: "bot", className: "User", bot: true } as never,
      hooks: { log: () => undefined },
      pollIntervalMs: 100,
      stepWaitMs: 400,
    },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stepReplies[0], "签到成功", "晚到的签到回复归签到步");
  assert.equal(outcome.stepReplies[1], MYINFO_TEXT, "/myinfo 步拿自己的回复");
  assert.notEqual(outcome.stepReplies[0], outcome.stepReplies[1], "两步的回复不能串");
  assert.equal(outcome.replyFullText, MYINFO_TEXT, "最后一步的回复仍是 myinfo 正文");
});
