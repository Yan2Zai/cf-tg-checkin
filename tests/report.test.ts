/** 汇总推送：消息拼装 + 续费推送（名字按 tg-signer 的推送格式 key，bot 用占位符） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  buildReportMessage,
  buildRenewalMessages,
  briefFailReason,
  fieldValue,
  lineValue,
  stripEmoji,
  toReportStatus,
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

test("briefFailReason：失败原因缩成一句话", () => {
  assert.equal(briefFailReason("步骤2 没找到按钮「签到」"), "按钮超时");
  assert.equal(briefFailReason("未匹配到关键词（签到成功）"), "无回复");
  assert.equal(briefFailReason("超出时间预算，未跑完所有步骤"), "执行超时");
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
  assert.ok(text.includes("🔴宸宇：无回复"));
  assert.ok(!text.includes("宸宇：到期时间"), "失败任务不贴旧值");
  assert.deepEqual(buttons, [{ label: "宸宇", url: "https://t.me/example_bot" }]);
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
