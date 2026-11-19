import test from "node:test";
import assert from "node:assert/strict";
import {
  MSG,
  PROJECT_URL,
  makePacket,
  readPacket,
  encodeServerMessage,
  parseServerMessage
} from "../src/protocol.js";
import { ProtoWriter } from "../src/protobuf.js";
import { ipToInt } from "../src/ip.js";

test("RELAY_PROBE 系列消息类型编号不重叠且对齐上游", () => {
  // 上游 vnt-def/vnt (v2) MsgType：RelayProbe=18、RelayProbeReply=19
  assert.equal(MSG.RELAY_PROBE_CLIENT, 18);
  assert.equal(MSG.RELAY_PROBE_REPLY_CLIENT, 19);
  assert.notEqual(MSG.RELAY_PROBE_CLIENT, MSG.RELAY_PROBE_REPLY_CLIENT);
});

test("readPacket 的 payload 为零拷贝视图且内容正确", () => {
  const payload = new Uint8Array([11, 22, 33, 44]);
  const packet = makePacket(MSG.TURN, payload, { ttl: 6, src: ipToInt("10.46.0.2"), dest: ipToInt("10.46.0.3") });
  const parsed = readPacket(packet);
  assert.deepEqual(Array.from(parsed.payload), [11, 22, 33, 44]);
  // 视图与原 buffer 共享内存：修改原 buffer 应同步反映在 payload 上
  packet[16] = 99;
  assert.equal(parsed.payload[0], 99);
});

test("ProtoWriter 扩容后仍能正确编码大字段", () => {
  const writer = new ProtoWriter();
  const big = new Uint8Array(300 * 1024).fill(7);
  writer.bytes(1, big);
  const out = writer.finish();
  // 头部为 tag(0x0A) + 长度 varint，正文为 300KB 的 7
  assert.equal(out[0], 0x0a);
  assert.ok(out.length > 300 * 1024);
  const body = out.subarray(out.length - big.length);
  assert.equal(body[0], 7);
  assert.equal(body[body.length - 1], 7);
});

test("ProtoWriter 拒绝超过上限的消息", () => {
  const writer = new ProtoWriter();
  assert.throws(() => writer.bytes(1, new Uint8Array(2 * 1024 * 1024 + 1)), /超过大小限制/);
});

test("ProtoWriter 连续多次写入不会串位", () => {
  const writer = new ProtoWriter();
  writer.string(1, "alpha");
  writer.uint(2, 300);
  writer.fixed32(3, ipToInt("10.46.0.9"));
  writer.bool(4, true);
  const out = writer.finish();
  assert.ok(out.length > 0);
  // 首字节应为 field=1, wire=2 => 0x0A
  assert.equal(out[0], 0x0a);
});

test("PROJECT_URL 指向本项目仓库", () => {
  assert.match(PROJECT_URL, /^https:\/\/github\.com\/[^/]+\/[^/]+$/);
  assert.ok(PROJECT_URL.endsWith("/vnts2-ws"));
});

test("ServerMessage 互联网关往返编解码保持稳定", () => {
  const packet = makePacket(MSG.RELAY_PROBE_CLIENT, new Uint8Array([5, 5]), {
    ttl: 3,
    src: ipToInt("10.46.0.2"),
    dest: ipToInt("10.46.0.3")
  });
  const bytes = encodeServerMessage({ forwardData: { networkCode: "net1", data: packet } });
  const msg = parseServerMessage(bytes);
  assert.equal(msg.forwardData.networkCode, "net1");
  const parsed = readPacket(msg.forwardData.data);
  assert.equal(parsed.msgType, MSG.RELAY_PROBE_CLIENT);
  assert.equal(parsed.destId, ipToInt("10.46.0.3"));
});
