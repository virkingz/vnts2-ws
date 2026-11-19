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

test("traceRequestMessage 对畸形输入不抛错，且能指出中断位置", async () => {
  const { traceRequestMessage } = await import("../src/protocol.js");
  // 真实线上包的前 32 字节：外层声明长度 105，但只给到 32 字节 -> 应报告中断
  const hex = "0a 69 09 77 61 6e 67 7a 68 61 6e 67 12 24 37 39 66 33 66 66 33 66 32 64 63 33 31 63 36 33 64 34 63";
  const bytes = new Uint8Array(hex.split(" ").map((h) => parseInt(h, 16)));
  const lines = traceRequestMessage(bytes);
  assert.ok(Array.isArray(lines) && lines.length > 0);
  assert.ok(lines.some((l) => l.includes("中断")), "应包含中断说明");
});

// 尾部字段不兼容时的容错：只要必要条件（network_code + device_id）齐全就放行。
// 背景：vnt2 v2.0.12 客户端注册包尾部含服务端未定义字段，
// 解析到该处会错位并报「不支持的 protobuf wire type：6」，导致整包被丢弃。
test("尾部字段畸形但必需字段齐全时应容错放行", async () => {
  const { ProtoWriter } = await import("../src/protobuf.js");
  const reg = new ProtoWriter();
  reg.string(1, "wangzhang");
  reg.string(2, "79f1e67-c3ac-4c42-ad5c-b87abab96258");
  reg.string(4, "sugon2");
  reg.string(5, "2.0.12");
  const body = reg.finish();
  const bad = new Uint8Array(body.length + 1);
  bad.set(body);
  bad[body.length] = 0x0e; // field1 / wire6 -> 非法 wire
  const req = new ProtoWriter();
  req.message(1, bad);

  const parsed = parseRequestMessage(req.finish());
  assert.equal(parsed.reg.networkCode, "wangzhang");
  assert.equal(parsed.reg.deviceId, "79f1e67-c3ac-4c42-ad5c-b87abab96258");
  assert.equal(parsed.reg.name, "sugon2");
  assert.ok(parsed.reg.parseWarning, "应记录 parseWarning");
});

test("尾部畸形且缺少 device_id 时仍应抛错", async () => {
  const { ProtoWriter } = await import("../src/protobuf.js");
  const reg = new ProtoWriter();
  reg.string(1, "wangzhang"); // 只有网络编号，无 device_id
  const body = reg.finish();
  const bad = new Uint8Array(body.length + 1);
  bad.set(body);
  bad[body.length] = 0x0e;
  const req = new ProtoWriter();
  req.message(1, bad);

  assert.throws(() => parseRequestMessage(req.finish()), /wire type/);
});
