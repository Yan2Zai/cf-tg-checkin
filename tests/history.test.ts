/** 只读历史接口：入参校验与消息归一化 */
import assert from "node:assert/strict";
import { test } from "./harness.ts";
import {
  normalizeHistoryMessage,
  normalizeHistoryMessages,
  parseHistoryRequest,
} from "../src/telegram/executor.ts";

test("parseHistoryRequest：peer 为空报错", () => {
  assert.throws(() => parseHistoryRequest({}), /目标为空/);
  assert.throws(() => parseHistoryRequest({ peer: "   " }), /目标为空/);
  assert.throws(() => parseHistoryRequest({ peer: "" }), /目标为空/);
});

test("parseHistoryRequest：peer 去掉前后空白", () => {
  assert.deepEqual(parseHistoryRequest({ peer: "  @example_group  " }), {
    peer: "@example_group",
    limit: 100,
  });
});

test("parseHistoryRequest：limit 默认 100、越界截断", () => {
  assert.equal(parseHistoryRequest({ peer: "@example_group" }).limit, 100);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: undefined }).limit, 100);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: "abc" }).limit, 100);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: 0 }).limit, 1);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: -5 }).limit, 1);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: 1 }).limit, 1);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: 200 }).limit, 200);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: 500 }).limit, 200);
  assert.equal(parseHistoryRequest({ peer: "@example_group", limit: "50" }).limit, 50);
});

test("normalizeHistoryMessage：完整消息（秒转毫秒、取发送者）", () => {
  const message = {
    id: 7,
    date: 1795449600,
    message: "示例消息正文",
    fromId: { className: "PeerUser", userId: 123456789 },
  } as never;
  assert.deepEqual(normalizeHistoryMessage(message), {
    id: 7,
    date: 1795449600000,
    text: "示例消息正文",
    senderId: "123456789",
  });
});

test("normalizeHistoryMessage：频道发送者与 BigInteger 形式的 id", () => {
  const message = {
    id: 8,
    date: 1795449601,
    message: "频道帖子",
    fromId: { className: "PeerChannel", channelId: { toString: () => "123456789" } },
  } as never;
  assert.deepEqual(normalizeHistoryMessage(message), {
    id: 8,
    date: 1795449601000,
    text: "频道帖子",
    senderId: "123456789",
  });
});

test("normalizeHistoryMessage：没有正文也保留 id/date，没有发送者不填 senderId", () => {
  const message = { id: 9, date: 1795449602 } as never;
  assert.deepEqual(normalizeHistoryMessage(message), { id: 9, date: 1795449602000, text: "" });
  const noDate = { id: 10, message: "只有正文" } as never;
  assert.deepEqual(normalizeHistoryMessage(noDate), { id: 10, date: 0, text: "只有正文" });
});

test("normalizeHistoryMessages：按 id 升序排", () => {
  const messages = [
    { id: 30, date: 1795449602, message: "第三条" },
    { id: 10, date: 1795449600, message: "第一条" },
    { id: 20, date: 1795449601, message: "第二条" },
  ] as never;
  assert.deepEqual(
    normalizeHistoryMessages(messages).map((item) => item.id),
    [10, 20, 30],
  );
  assert.deepEqual(normalizeHistoryMessages([]), []);
});
