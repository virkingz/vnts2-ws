import test from "node:test";
import assert from "node:assert/strict";
import { isValidClientInfoResponse } from "../src/room.js";
import { encodeServerMessage } from "../src/protocol.js";

// 背景：互联节点状态误报。
// 未部署的对端经 EdgeOne/Cloudflare 反代时返回 200 + 空响应，
// 原实现只看 res.ok，导致这些节点被显示为「在线」。
// 修复后必须校验响应内容确实包含 ClientInfoResponse（field 8）。

test("空响应应判为无效（未部署节点经反代返回 200 空体）", () => {
  assert.equal(isValidClientInfoResponse(new Uint8Array(0)), false);
});

test("HTML 错误页应判为无效", () => {
  const html = new TextEncoder().encode("<html><body>404</body></html>");
  assert.equal(isValidClientInfoResponse(html), false);
});

test("随机字节应判为无效且不抛错", () => {
  assert.equal(isValidClientInfoResponse(new Uint8Array([0xff, 0xee, 0xdd])), false);
  assert.equal(isValidClientInfoResponse(new Uint8Array([0x80])), false);
});

test("缺少 clientInfoRes 的合法 protobuf 应判为无效", () => {
  // 只有 clientInfoReq（请求方向），不是响应
  const req = encodeServerMessage({ clientInfoReq: { networkCodes: [] } });
  assert.equal(isValidClientInfoResponse(req), false);
});

test("包含 clientInfoRes 的响应应判为有效", () => {
  const res = encodeServerMessage({ clientInfoRes: { networks: [] } });
  assert.equal(isValidClientInfoResponse(res), true);
});

test("null / undefined 输入应判为无效", () => {
  assert.equal(isValidClientInfoResponse(null), false);
  assert.equal(isValidClientInfoResponse(undefined), false);
});
