/** 汇总推送：消息拼装 + 续费推送（名字按 tg-signer 的推送格式 key，bot 用占位符） */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  buildExpiryWarnings,
  buildReportMessage,
  buildRenewalMessages,
  briefFailReason,
  fieldValue,
  lineValue,
  mergeRenewals,
  mergeSummaryResults,
  renewalFailureWarnings,
  selectRetryTargets,
  stripEmoji,
  stripPasswordLines,
  toReportStatus,
  type PanelSummaryResult,
  type ReportTaskResult,
} from "../src/report.ts";
import { parseBalance } from "../src/renew.ts";

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

test("toReportStatus：群任务按群组回复定状态，没回执才记 ran", () => {
  assert.equal(toReportStatus(true, "签到成功", false), "success");
  assert.equal(toReportStatus(true, "今天已经签到过了", false), "already");
  assert.equal(toReportStatus(false, "", false), "failed");
  assert.equal(toReportStatus(true, "🎉签到成功🎉", true), "success");
  assert.equal(toReportStatus(true, "您今天已经签到过了！", true), "already");
  assert.equal(toReportStatus(true, "", true), "ran");
  assert.equal(toReportStatus(false, "", true), "failed");
});

test("buildReportMessage：全部成功时只写计数，不留空行", () => {
  const { text, buttons } = buildReportMessage(
    [task({ name: "法拉利", reply: "签到成功\n账户剩余：100\n流量奖励：5G" })],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.equal(text, "11-23 ✅1\n🟢法拉利 100 · 5G");
  assert.deepEqual(buttons, []);
});

test("buildReportMessage：失败任务只报失败名，不贴旧值，且带按钮", () => {
  const { text, buttons } = buildReportMessage(
    [
      task({ name: "法拉利", reply: "签到成功\n账户剩余：100\n流量奖励：5G" }),
      task({ name: "宸宇", status: "failed", reply: "未匹配到关键词", failReason: "无回复" }),
    ],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.equal(text, "11-23 ✅1 · ❌1\n🔴宸宇\n🟢法拉利 100 · 5G");
  assert.ok(!text.includes("无回复"), "失败行不带细分原因");
  assert.ok(!text.includes("宸宇：到期时间"), "失败任务不贴旧值");
  assert.deepEqual(buttons, [{ label: "宸宇", url: "https://t.me/example_bot" }]);
});

test("buildReportMessage：失败行只列名字，不写「失败」二字，旧的细分原因也不进推送", () => {
  const { text } = buildReportMessage(
    [
      task({ name: "宸宇", status: "failed", reply: "步骤2 没找到按钮「签到」", failReason: "按钮超时" }),
      task({ name: "乐蛙", status: "failed", reply: "超出时间预算，未跑完所有步骤" }),
    ],
    "11 月 25 日 00:00",
    "11 月 25 日",
  );
  assert.equal(text, "11-25 ✅0 · ❌2\n🔴宸宇 🔴乐蛙");
  assert.ok(!text.includes("按钮超时"), "failReason 里的细分原因不进推送");
  assert.ok(!text.includes("没找到按钮"), "reply 里的原因也不进失败行");
  assert.ok(!text.includes("超出时间预算"));
});

test("buildReportMessage：已签单独计数，🔵 详情行置顶", () => {
  const { text } = buildReportMessage(
    [
      task({ name: "乐观", status: "already", reply: "已经签到\n有效期至 2026-12-14" }),
      task({ name: "宸宇", reply: "签到成功\n到期时间：2027-02-14" }),
    ],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.equal(text, "11-23 ✅1 · 已签1\n🔵乐观 2026-12-14\n🟢宸宇 2027-02-14");
});

test("buildReportMessage：法拉利没有值时折进最后一行", () => {
  const { text } = buildReportMessage(
    [task({ name: "法拉利", reply: "签到成功" }), task({ name: "乐蛙", reply: "签到成功\n有效期至 2026-11-28" })],
    "11 月 23 日 20:00",
    "11 月 23 日",
  );
  assert.equal(text, "11-23 ✅2\n🟢乐蛙 2026-11-28\n✅ 法拉利");
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

test("buildRenewalMessages：距到期 ≤7 天且读不到余额时推 ⚠️ 预警", () => {
  const msgs = buildRenewalMessages([
    { name: "宸宇", bot: "@example_bot", outcome: "no-balance-found", button: "积分续期30天", detail: "回复里没有找到积分余额", daysLeft: 5 },
  ]);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].text.startsWith("⚠️ 宸宇续费预警："), msgs[0].text);
  assert.ok(msgs[0].text.includes("距到期 5 天"), msgs[0].text);
  assert.equal(msgs[0].buttons.length, 1);
});

test("buildRenewalMessages：距到期 ≤7 天且余额不足阈值时推 ⚠️ 预警", () => {
  const msgs = buildRenewalMessages([
    { name: "乐蛙", bot: "@example_bot", outcome: "balance-below-threshold", button: "周卡", detail: "余额 100 小于阈值 699", daysLeft: 3 },
  ]);
  assert.equal(msgs.length, 1);
  assert.ok(msgs[0].text.startsWith("⚠️ 乐蛙续费预警："), msgs[0].text);
  assert.ok(msgs[0].text.includes("距到期 3 天"), msgs[0].text);
});

test("buildRenewalMessages：距到期超过 7 天或未知时，读不到余额仍静默", () => {
  const msgs = buildRenewalMessages([
    { name: "宸宇", bot: "@example_bot", outcome: "no-balance-found", button: "积分续期30天", detail: "回复里没有找到积分余额", daysLeft: 30 },
    { name: "宸宇2", bot: "@example_bot", outcome: "no-balance-found", button: "积分续期30天", detail: "回复里没有找到积分余额", daysLeft: null },
    { name: "乐蛙", bot: "@example_bot", outcome: "balance-below-threshold", button: "周卡", detail: "余额 100 小于阈值 699", daysLeft: 20 },
  ]);
  assert.equal(msgs.length, 0);
});

test("buildReportMessage：新任务只按到期时间给详情行，本月 alone 不给", () => {
  const { text } = buildReportMessage(
    [
      task({ name: "示例新任务", reply: "签到成功\n到期时间：2027-03-01" }),
      task({ name: "示例新任务2", reply: "签到成功\n有效期至 2027-03-01" }),
      task({ name: "示例新任务3", reply: "签到成功\n本月 5小时" }),
    ],
    "11 月 25 日 00:00",
    "11 月 25 日",
  );
  assert.equal(text, "11-25 ✅3\n🟢示例新任务 2027-03-01\n🟢示例新任务2 2027-03-01\n✅ 示例新任务3");
});

test("buildReportMessage：现有 10 个任务的详情行新格式", () => {
  const { text } = buildReportMessage(
    [
      task({ name: "茶包", reply: "签到成功\n到期时间：2027-01-01\n上次活动 11-20\n过去30天 5小时" }),
      task({ name: "茶百道", reply: "签到成功\n到期时间：2027-01-02\n上次活动 11-21" }),
      task({ name: "帝服", reply: "签到成功\n到期时间：2027-01-03\n上次活动 11-22" }),
      task({
        name: "闷豹",
        reply: "签到成功\nEmby：已绑定｜本周期到期：2027-01-04 21:14\n进度：14/14 ✅",
      }),
      task({ name: "宸宇", reply: "签到成功\n到期时间：2027-02-14" }),
      task({ name: "宸宇2", reply: "签到成功\n到期时间：2027-01-15" }),
      task({ name: "乐观", status: "already", reply: "已经签到\n有效期至 2026-12-14" }),
      task({ name: "乐蛙", reply: "签到成功\n有效期至 2026-11-28" }),
      task({ name: "绿洲", reply: "签到成功\n本月：11 次播放，1小时4分钟" }),
      task({
        name: "BB",
        reply: "签到成功\n保号要求：最近 30 天累计播放至少 3 小时\n本周期保号累计：2 小时 0 分钟\n下次考核时间：2026-12-01 20:07",
      }),
    ],
    "11 月 25 日 00:00",
    "11 月 25 日",
    [],
    "2026-11-25",
  );
  assert.equal(
    text,
    [
      "11-25 ✅9 · 已签1",
      "🔵乐观 2026-12-14",
      "🟢宸宇 2027-02-14",
      "🟢宸宇2 2027-01-15",
      "🟢绿洲 本月11次·1h4m",
      "🟢BB 2/3h · 考核12-01",
      "🟢茶百道 上次活动11-21",
      "🟢闷豹 01-04 21:14到期 · 14/14✅",
      "🟢帝服 上次活动11-22",
      "🟢茶包 2027-01-01",
      "🟢乐蛙 2026-11-28（剩3天）",
    ].join("\n"),
  );
});

test("stripPasswordLines：只删密码行，余额/到期时间等字段保留，余额仍能解析", () => {
  const raw = "签到成功\n账号：示例账号\n🔑 密码：占位值\n积分余额：204\n有效期至 2026-12-21";
  const filtered = stripPasswordLines(raw);
  assert.ok(!filtered.includes("密码"), filtered);
  assert.ok(!filtered.includes("占位值"), filtered);
  assert.ok(filtered.includes("积分余额：204"), filtered);
  assert.ok(filtered.includes("有效期至 2026-12-21"), filtered);
  assert.ok(filtered.includes("账号：示例账号"), filtered);
  assert.equal(parseBalance(filtered), 204);
  assert.equal(stripPasswordLines("签到成功\n积分余额：100"), "签到成功\n积分余额：100");
  assert.equal(stripPasswordLines(""), "");
});

test("buildExpiryWarnings：P1-4 没覆盖到的快到期且余额不足才预警，乐观 26 天不预警", () => {
  const results: PanelSummaryResult[] = [
    summaryRow({ name: "乐观", reply: "积分余额：204\n有效期至 2026-12-21" }),
    summaryRow({ name: "示例任务", botUsername: "@other_bot", reply: "积分余额：100\n到期时间 2026-11-28" }),
    summaryRow({ name: "示例任务2", botUsername: "@third_bot", reply: "积分余额：50\n到期时间 2026-11-27" }),
  ];
  const warnings = buildExpiryWarnings(
    results,
    [
      { name: "示例任务", bot: "@other_bot", outcome: "balance-below-threshold", button: "周卡", detail: "余额 100 小于阈值 699", daysLeft: null },
      { name: "示例任务2", bot: "@third_bot", outcome: "balance-below-threshold", button: "周卡", detail: "余额 50 小于阈值 699", daysLeft: 2 },
    ],
    [
      { name: "乐观", minBalance: 700 },
      { name: "示例任务", minBalance: 699 },
      { name: "示例任务2", minBalance: 699 },
    ],
    "2026-11-25",
  );
  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.ok(warnings[0].startsWith("⚠️ 示例任务续费预警："), warnings[0]);
  assert.ok(warnings[0].includes("余额 100 小于阈值 699"), warnings[0]);
  assert.ok(warnings[0].includes("距到期 3 天"), warnings[0]);
});

test("buildExpiryWarnings：已续费的不预警，余额够的不预警", () => {
  const warnings = buildExpiryWarnings(
    [
      summaryRow({ name: "宸宇", reply: "积分余额：500\n到期时间 2026-11-27" }),
      summaryRow({ name: "宸宇2", botUsername: "@other_bot", reply: "积分余额：800\n到期时间 2026-11-27" }),
    ],
    [
      { name: "宸宇", bot: "@example_bot", outcome: "renewed", button: "积分续期30天", detail: "" },
    ],
    [
      { name: "宸宇", minBalance: 400 },
      { name: "宸宇2", minBalance: 400 },
    ],
    "2026-11-25",
  );
  assert.deepEqual(warnings, []);
});

test("buildReportMessage：预警行跟在失败行后、详情行之前", () => {
  const { text } = buildReportMessage(
    [task({ name: "宸宇", reply: "签到成功\n到期时间：2027-02-14" })],
    "11 月 25 日 00:00",
    "11 月 25 日",
    ["⚠️ 示例任务续费预警：余额 100 小于阈值 699，距到期 3 天"],
  );
  assert.equal(
    text,
    "11-25 ✅1\n⚠️ 示例任务续费预警：余额 100 小于阈值 699，距到期 3 天\n🟢宸宇 2027-02-14",
  );
});

test("selectRetryTargets：只挑上一轮失败的，BB 排除，已重跑过的跳过", () => {
  const picked = selectRetryTargets(
    [
      summaryRow({ name: "宸宇", status: "failed" }),
      summaryRow({ name: "BB", botUsername: "@bbembybot", status: "failed" }),
      summaryRow({ name: "乐观", status: "success" }),
      summaryRow({ name: "乐蛙", botUsername: "@other_bot", status: "failed" }),
    ],
    ["yanneo20|@other_bot"],
  );
  assert.deepEqual(picked.targets.map((r) => r.name), ["宸宇"]);
  assert.deepEqual(picked.skippedBB, ["BB"]);
  assert.deepEqual(picked.skippedRetried, ["乐蛙"]);
});

test("mergeSummaryResults：lastDurationMs 随结果一起合并保留", () => {
  const merged = mergeSummaryResults(
    [summaryRow({ name: "宸宇", lastDurationMs: 1200 })],
    [summaryRow({ name: "乐观", botUsername: "@other_bot", lastDurationMs: 3400 })],
  );
  assert.equal(merged.find((r) => r.name === "宸宇")!.lastDurationMs, 1200);
  assert.equal(merged.find((r) => r.name === "乐观")!.lastDurationMs, 3400);
});

test("buildReportMessage：只拿到按钮回调的任务不再单独标 ⚠️，无详情行时折叠", () => {
  const { text, buttons } = buildReportMessage(
    [
      task({ name: "佬友记", reply: "【仅回调】签到中...", callbackOnly: true }),
      task({ name: "宸宇", status: "failed", reply: "未匹配到关键词", failReason: "无回复" }),
    ],
    "11 月 25 日 00:00",
    "11 月 25 日",
  );
  assert.equal(text, "11-25 ✅1 · ❌1\n🔴宸宇\n✅ 佬友记");
  assert.ok(!text.includes("⚠️"), "不再标回调 ⚠️ 行");
  assert.ok(!text.includes("无回复"), "失败行不带细分原因");
  assert.deepEqual(buttons, [{ label: "宸宇", url: "https://t.me/example_bot" }]);
});

test("buildReportMessage：到期 ≤7 天加剩天数，当天到期写今晚", () => {
  const { text } = buildReportMessage(
    [
      task({ name: "宸宇", reply: "签到成功\n到期时间：2026-11-30" }),
      task({
        name: "闷豹",
        status: "already",
        reply: "Emby：已绑定｜本周期到期：2026-11-27 21:14\n进度：14/14 ✅",
      }),
    ],
    "11 月 27 日 00:00",
    "11 月 27 日",
    [],
    "2026-11-27",
  );
  assert.equal(text, "11-27 ✅1 · 已签1\n🔵闷豹 今晚21:14到期 · 14/14✅\n🟢宸宇 2026-11-30（剩3天）");
});

test("renewalFailureWarnings：续费失败只写一行，不附原因", () => {
  const warnings = renewalFailureWarnings([
    { name: "钟陌", bot: "@example_bot", outcome: "not-renewed", button: "积分续期", detail: "发 /shop 后机器人提示点 /start" },
    { name: "乐观", bot: "@example_bot", outcome: "balance-below-threshold", button: "续费7天", detail: "余额 425 小于阈值 700" },
    { name: "宸宇", bot: "@example_bot", outcome: "renewed", button: "积分续期30天", detail: "" },
  ]);
  assert.deepEqual(warnings, ["⚠️钟陌续费失败"]);
});

test("buildReportMessage：11-27 全量（19 个任务）按新格式输出", () => {
  const { text, buttons } = buildReportMessage(
    [
      task({ name: "muse2", reply: "✅ 签到成功！连续签到 5 天，当前剩余 5 次机会。" }),
      task({ name: "宸宇2", reply: "· 🚨 到期时间 | 2027-01-15 23:36:29" }),
      task({ name: "佬友记", reply: "签到中...", callbackOnly: true }),
      task({ name: "ok", reply: "· 🍥 持有OK币 | 154\n· 🚨 到期时间 | 2026-12-25 01:30:21" }),
      task({
        name: "法拉利",
        reply: "✅ 每日签到成功！\n\n📊 账户剩余：154.85 GB\n🎁 流量奖励：+122 MB",
      }),
      task({ name: "海豚", reply: "🎉 幸运签到成功 | +3 海豚币\n💴 当前持有 | 122 海豚币" }),
      task({ name: "ikuuuu", reply: "签到成功！获得了 2907 MB 流量！" }),
      task({ name: "茶百道", reply: "· 🔋 上次活动 ｜ 2026-11-26 16:08:30" }),
      task({
        name: "BB",
        reply:
          "保号要求：最近 30 天累计播放至少 3 小时；未达标禁用账号。\n本周期保号累计：0 小时 0 分钟。\n下次考核时间：2026-12-11 20:07",
      }),
      task({ name: "muse1", reply: "✅ 签到成功！连续签到 17 天，当前剩余 2 次机会。" }),
      task({ name: "蜗牛", botUsername: "@example_bot", status: "failed", reply: "" }),
      task({ name: "钟陌", reply: "⏰ 到期时间 | 2028-10-13（剩 686 天）\n🍒 积分 | 13" }),
      task({ name: "BDL", reply: "签到中...", callbackOnly: true }),
      task({ name: "帝服", botUsername: "@other_bot", status: "failed", reply: "" }),
      task({ name: "群每日签到", reply: "🎉签到成功🎉\n✅已获得获得了1积分。\n您剩余的积分为：13" }),
      task({
        name: "闷豹",
        status: "already",
        reply: "🎬 Emby：已绑定｜本周期到期：2026-11-27 21:14（北京时间）\n📈 进度：14/14 ✅",
      }),
      task({ name: "宸宇", reply: "· 🚨 到期时间 | 2027-02-14 20:44:18" }),
      task({ name: "乐观", reply: "⏳ 有效期至：2026-12-21（剩余 24 天）" }),
      task({ name: "绿洲", reply: "📅 本月：11 次播放，1小时4分钟" }),
    ],
    "11 月 27 日 00:02",
    "11 月 27 日",
    ["⚠️钟陌续费失败"],
    "2026-11-27",
  );
  assert.equal(
    text,
    [
      "11-27 ✅16 · 已签1 · ❌2",
      "🔴蜗牛 🔴帝服",
      "⚠️钟陌续费失败",
      "🔵闷豹 今晚21:14到期 · 14/14✅",
      "🟢法拉利 154.85G · +122M",
      "🟢宸宇 2027-02-14",
      "🟢宸宇2 2027-01-15",
      "🟢乐观 2026-12-21",
      "🟢绿洲 本月11次·1h4m",
      "🟢BB 0/3h · 考核12-11",
      "🟢茶百道 上次活动11-26",
      "✅ muse2 佬友记 ok 海豚 ikuuuu muse1 钟陌 BDL 群签到",
    ].join("\n"),
  );
  assert.deepEqual(buttons, [
    { label: "蜗牛", url: "https://t.me/example_bot" },
    { label: "帝服", url: "https://t.me/other_bot" },
  ]);
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
