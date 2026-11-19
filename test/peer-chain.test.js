import test from "node:test";
import assert from "node:assert/strict";
import { filterRemoteClients } from "../src/room.js";

// 本次修复的核心：跨节点同步链路上有三处会丢字段，导致
//   1) 状态页「互联」行为同一设备显示多条（去重失效）
//   2) 名称列为空、版本列显示 "-"
//
// 三处丢字段的位置：
//   a. fetchPeerClients → peerClientCache 构建时只取 ip/latencyMs/online
//   b. handleRoomPage → info.peerClients 映射时只取 ip/peer
//   c. 状态页渲染互联客户端时只填 虚拟IP/状态/服务端
//
// 这些位置依赖真实运行环境（Durable Object / HTTP 页面），不便直接单测。
// 此处用 filterRemoteClients 覆盖「设备同时连多节点 + 补齐字段」这一核心契约：
// 远端条目带 deviceId 时应被判重，且其 name/version 需被保留以便展示。

test("远端条目保留 deviceId/name/version（供展示与去重）", () => {
  const devices = new Map();
  const remote = [
    { ip: 1, deviceId: "d1", name: "sugonOp", version: "2.0.12", online: true }
  ];
  const out = filterRemoteClients(devices, remote, 999);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "sugonOp");
  assert.equal(out[0].version, "2.0.12");
  assert.equal(out[0].deviceId, "d1");
});

test("同一设备同时连两个节点时，远端同 deviceId 条目应被剔除", () => {
  // 本地已注册该设备（主用节点）
  const devices = new Map([
    ["dev-x", { deviceId: "dev-x", ip: 0x0a1a02cd, name: "sugonOp", version: "2.0.12" }]
  ]);
  // 远端（备用节点）也有同一 deviceId，但分配到了不同 IP
  const remote = [
    { ip: 0x0a1a02ce, deviceId: "dev-x", name: "sugonOp", version: "2.0.12", online: true }
  ];
  const out = filterRemoteClients(devices, remote, 999);
  assert.deepEqual(out, [], "同 deviceId 应判为同一设备，不重复显示");
});

test("对端为旧版本（无 deviceId）时退回按 IP 判重", () => {
  const devices = new Map([
    ["dev-x", { deviceId: "dev-x", ip: 0x0a1a02cd }]
  ]);
  const remote = [
    { ip: 0x0a1a02cd }, // 同 IP，无 deviceId
    { ip: 0x0a1a02ce }  // 不同 IP，应保留
  ];
  const out = filterRemoteClients(devices, remote, 999);
  assert.equal(out.length, 1);
  assert.equal(out[0].ip, 0x0a1a02ce);
});

test("客户端自身 IP 不出现在互联列表中", () => {
  const devices = new Map();
  const remote = [
    { ip: 0x0a1a02cd, deviceId: "self" },
    { ip: 0x0a1a02ce, deviceId: "other" }
  ];
  const out = filterRemoteClients(devices, remote, 0x0a1a02cd);
  assert.equal(out.length, 1);
  assert.equal(out[0].deviceId, "other");
});
