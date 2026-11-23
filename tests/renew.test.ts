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
} from "../src/renew.ts";

test("parseBalance：两种余额写法都认", () => {
  assert.equal(parseBalance("积分余额：1234\n有效期至 2027-01-01"), 1234);
  assert.equal(parseBalance("持有积分 | 567"), 567);
  assert.equal(parseBalance("持有积分｜89"), 89);
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
