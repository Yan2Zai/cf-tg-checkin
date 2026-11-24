/** 汇总推送：消息拼装 + 续费推送（名字按 tg-signer 的推送格式 key，bot 用占位符） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  buildReportMessage,
  buildRenewalMessages,
  briefFailReason,
  fieldValue,
  lineValue,
  mergeRenewals,
  mergeSummaryResults,
  stripEmoji,
  toReportStatus,
  type PanelSummaryResult,
  type ReportTaskResult,
} from "../src/report.ts";

const task = (over: Partial<ReportTaskResult>): ReportTaskResult => ({
  name: "示例任务",
  botUsername: "@example_bot",
  status: "success",
  reply: "签到成功",
  ranAt: "11 月 23 日 20:00",
  ...over,
});

test("stripEmoji / fieldValue / lineValue：只取标签后面的值", () => {
  assert.equal(stripEmoji("🎉 123 🎉"), "123");
  assert.equal(fieldValue("账户剩余：100\n流量奖励：5G", "账户剩余"), "100");
  assert.equal(fieldValue("账户剩余：100\n流量奖励：5G", "流量奖励"), "5G");
  assert.equal(fieldValue("没有标签", "账户剩余"), null);
  assert.equal(lineValue("第一行\n到期时间：2027-02-14\n第三行", "到期时间"), "2027-02-14");
});

test("briefFailReason：对外推送的失败只写「失败」，不细分原因", () => {
  assert.equal(briefFailReason("步骤2 没找到按钮「签到」"), "失败");
  assert.equal(briefFailReason("未匹配到关键词（签到成功）"), "失败");
  assert.equal(briefFailReason("超出时间预算，未跑完所有步骤"), "失败");
  assert.equal(briefFailReason(""), "失败");
});

test("toReportStatus：群只发消息记 ran，已经签的单独算", () => {
  assert.equal(toReportStatus(true, "签到成功", false), "success");
  assert.equal(toReportStatus(true, "今天已经签到过了", false), "already");
  assert.equal(toReportStatus(false, "", false), "failed");
  assert.equal(toReportStatus(true, "", true), "ran");
});

test("buildReportMessage：全部成功时只写计数，不留空行", () => {
  const { text, buttons } = buildReportMessage(
    [task({ name: "法拉利", reply: "签到成功\n账户剩余：100\n流量奖励：5G" })],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.equal(text, "11 月 23 日 签到结果（11 月 23 日 20:00 开始）\nTG 1/1 全部成功\n\n🟢法拉利：账户剩余 100，流量奖励 5G");
  assert.deepEqual(buttons, []);
});

test("buildReportMessage：失败任务只报失败行，不贴旧值，且带按钮", () => {
  const { text, buttons } = buildReportMessage(
    [
      task({ name: "法拉利", reply: "签到成功\n账户剩余：100\n流量奖励：5G" }),
      task({ name: "宸宇", status: "failed", reply: "未匹配到关键词", failReason: "无回复" }),
    ],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.ok(text.includes("TG 1 成功，1 失败"));
  assert.ok(text.includes("🔴宸宇：失败"));
  assert.ok(!text.includes("无回复"), "失败行不带细分原因");
  assert.ok(!text.includes("宸宇：到期时间"), "失败任务不贴旧值");
  assert.deepEqual(buttons, [{ label: "宸宇", url: "https://t.me/example_bot" }]);
});

test("buildReportMessage：失败行严格只写「失败」，旧的细分原因也不进推送", () => {
  const { text } = buildReportMessage(
    [
      task({ name: "宸宇", status: "failed", reply: "步骤2 没找到按钮「签到」", failReason: "按钮超时" }),
      task({ name: "乐蛙", status: "failed", reply: "超出时间预算，未跑完所有步骤" }),
    ],
    "11 月 25 日 00:00",
    "11 月 25 日",
  );
  assert.ok(text.includes("🔴宸宇：失败"));
  assert.ok(text.includes("🔴乐蛙：失败"));
  assert.ok(!text.includes("按钮超时"), "failReason 里的细分原因不进推送");
  assert.ok(!text.includes("没找到按钮"), "reply 里的原因也不进失败行");
  assert.ok(!text.includes("超出时间预算"));
});

test("buildReportMessage：已签单独计数，详情行按顺序排", () => {
  const { text } = buildReportMessage(
    [
      task({ name: "乐观", status: "already", reply: "已经签到\n有效期至 2026-12-14" }),
      task({ name: "宸宇", reply: "签到成功\n到期时间：2027-02-14" }),
    ],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.ok(text.includes("TG 1 成功，1 已签"));
  const chen = text.indexOf("🟢宸宇");
  const leguan = text.indexOf("🟢乐观");
  assert.ok(chen > 0 && leguan > chen, "宸宇排在乐观前面");
});

test("buildReportMessage：法拉利没有值时整行和空行都省掉", () => {
  const { text } = buildReportMessage(
    [task({ name: "法拉利", reply: "签到成功" }), task({ name: "乐蛙", reply: "签到成功\n有效期至 2026-11-28" })],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.ok(!text.includes("法拉利"));
  assert.ok(text.includes("🟢乐蛙：有效期至 2026-11-28"));
});

test("buildRenewalMessages：成功发 ✅，失败发 🔴，余额不足静默", () => {
  const msgs = buildRenewalMessages([
    { name: "乐观", bot: "@example_bot", outcome: "renewed", button: "续费7天", detail: "" },
    { name: "乐蛙", bot: "@example_bot", outcome: "balance-below-threshold", button: "周卡", detail: "" },
    { name: "宸宇", bot: "@example_bot", outcome: "click-sent-unclear", button: "积分续期30天", detail: "点击已发出" },
  ]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, "✅ 乐观自动续费成功：续费7天（700积分）");
  assert.ok(msgs[1].text.startsWith("🔴 宸宇自动续费失败："));
  assert.equal(msgs[1].buttons.length, 1);
});

const summaryRow = (over: Partial<PanelSummaryResult>): PanelSummaryResult => ({
  accountId: "yanneo20",
  botUsername: "@example_bot",
  status: "success",
  reply: "签到成功",
  ranAt: "11 月 24 日 00:01",
  via: "消息回复",
  ...over,
});

test("mergeSummaryResults：多批 tick 合并成全天，同一任务取最新", () => {
  const merged = mergeSummaryResults(
    [
      summaryRow({ botUsername: "@example_bot", name: "乐观", ranAt: "11 月 24 日 00:01" }),
      summaryRow({ botUsername: "@other_bot", name: "ok", ranAt: "11 月 24 日 00:01" }),
    ],
    [
      summaryRow({ botUsername: "@example_bot", name: "乐观", ranAt: "11 月 24 日 00:07", reply: "签到成功 | 10 积分" }),
      summaryRow({ botUsername: "@third_bot", name: "法拉利", ranAt: "11 月 24 日 00:10" }),
    ],
  );
  assert.equal(merged.length, 3);
  const leguan = merged.find((r) => r.botUsername === "@example_bot")!;
  assert.equal(leguan.ranAt, "11 月 24 日 00:07");
  assert.equal(leguan.reply, "签到成功 | 10 积分");
  assert.ok(merged.some((r) => r.botUsername === "@other_bot"));
  assert.ok(merged.some((r) => r.botUsername === "@third_bot"));
});

test("mergeSummaryResults：同 bot 不同账号是两个任务，旧版无 name 用 bot 兜底", () => {
  const merged = mergeSummaryResults(
    [summaryRow({ accountId: "guanhuo03", botUsername: "@example_bot" })],
    [summaryRow({ accountId: "yanneo20", botUsername: "@example_bot", name: "宸宇" })],
  );
  assert.equal(merged.length, 2);
  const old = merged.find((r) => r.accountId === "guanhuo03")!;
  assert.equal(old.name, "example_bot");
});

test("mergeRenewals：同一任务取最新，不同任务都保留", () => {
  const merged = mergeRenewals(
    [{ name: "乐观", bot: "@example_bot", outcome: "renewed", button: "续费7天", detail: "" }],
    [
      { name: "乐观", bot: "@example_bot", outcome: "failed", button: "续费7天", detail: "超时" },
      { name: "乐蛙", bot: "@example_bot", outcome: "balance-below-threshold", button: "周卡", detail: "" },
    ],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged.find((r) => r.name === "乐观")!.outcome, "failed");
});
