import test from "node:test";
import assert from "node:assert/strict";
import { parseRequestMessage } from "../src/protocol.js";

// 这些用例覆盖 WebSocket 升级成功后、首个数据包异常的场景。
// 线上日志曾出现：
//   会话异常关闭 会话=1 原因=读取 varint 时遇到意外 EOF
//   Uncaught Error: Network connection lost.
// 说明畸形/空包既会让注册失败，又可能逸出为未捕获错误。

test("空包不抛错，解析为空对象（由注册校验兜住）", () => {
  // 实测行为：空 Uint8Array 让 while(!eof) 直接跳过，返回 {}
  // 因此不会抛「意外 EOF」；真正报错发生在 handleRegister 的
  // 「首包必须是注册请求」。这里固化该行为，避免误判日志。
  assert.deepEqual(parseRequestMessage(new Uint8Array(0)), {});
});

test("截断的 varint 应抛出可捕获的错误（线上日志中的成因）", () => {
  // 0x80 表示「后续还有字节」，但数据到此为止。
  // 这正是「读取 varint 时遇到意外 EOF」的真实触发条件：
  // 数据包被中途截断（例如连接在传输中被打断）。
  assert.throws(() => parseRequestMessage(new Uint8Array([0x80])), /意外 EOF/);
});

test("非法 wire type 应抛出可捕获的错误", () => {
  // field=1 wire=7（7 是保留值，不合法）
  assert.throws(() => parseRequestMessage(new Uint8Array([0x0f, 0x00])));
});

test("随机字节不应让解析器挂起或崩溃", () => {
  // 遍历若干随机输入，只要求「抛出普通 Error」，不允许卡死或抛非 Error
  for (let i = 0; i < 200; i++) {
    const len = 1 + (i % 17);
    const bytes = new Uint8Array(len);
    for (let j = 0; j < len; j++) bytes[j] = (i * 31 + j * 7) & 0xff;
    try {
      parseRequestMessage(bytes);
    } catch (error) {
      assert.ok(error instanceof Error, `第 ${i} 组随机输入抛出了非 Error 值`);
    }
  }
});

test("声明超长 bytes 字段应被拒绝（不越界读取）", () => {
  // tag(field=1, wire=2) = 0x0a，随后声明长度 200 但只给 2 字节
  assert.throws(() => parseRequestMessage(new Uint8Array([0x0a, 0xc8, 0x01, 0x00, 0x00])), /意外 EOF/);
});
