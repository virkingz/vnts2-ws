import test from "node:test";
import assert from "node:assert/strict";
import { filterRemoteClients } from "../src/room.js";

// 背景：同一台设备同时连多个节点时，会在每个节点各注册一次。
// 各节点通过 PEER_SERVERS 同步客户端列表后，本地 devices 与远端列表
// 会同时包含该设备，直接拼接就在客户端设备列表里显示成多台。
// filterRemoteClients 负责剔除本地已有的远端条目（本地优先）。

function makeDevices(list) {
  const m = new Map();
  for (const d of list) m.set(d.deviceId, d);
  return m;
}

test("本地没有的远端设备应保留", () => {
  const devices = makeDevices([{ deviceId: "a", ip: 1 }]);
  const remote = [{ deviceId: "b", ip: 2 }];
  const out = filterRemoteClients(devices, remote, 999);
  assert.deepEqual(out.map((r) => r.deviceId), ["b"]);
});

test("同 deviceId 的远端设备应被剔除（多锚点重复注册）", () => {
  const devices = makeDevices([{ deviceId: "dup", ip: 10 }]);
  const remote = [{ deviceId: "dup", ip: 20 }];
  const out = filterRemoteClients(devices, remote, 999);
  assert.deepEqual(out, [], "本地已有同 deviceId，远端应全部剔除");
});

test("远端不带 deviceId 时按 IP 判重（兼容旧版本节点）", () => {
  const devices = makeDevices([{ deviceId: "a", ip: 10 }]);
  const remote = [{ ip: 10 }, { ip: 11 }];
  const out = filterRemoteClients(devices, remote, 999);
  assert.deepEqual(out.map((r) => r.ip), [11]);
});

test("远端内部重复项也应去重", () => {
  const devices = makeDevices([]);
  const remote = [
    { deviceId: "x", ip: 10 },
    { deviceId: "x", ip: 10 },
    { ip: 10 } // 同 IP 但无 deviceId
  ];
  const out = filterRemoteClients(devices, remote, 999);
  assert.equal(out.length, 1);
  assert.equal(out[0].ip, 10);
});

test("应排除会话自身 IP", () => {
  const devices = makeDevices([{ deviceId: "a", ip: 10 }]);
  const remote = [{ deviceId: "me", ip: 50 }, { deviceId: "b", ip: 60 }];
  const out = filterRemoteClients(devices, remote, 50);
  assert.deepEqual(out.map((r) => r.ip), [60]);
});

test("本地设备缺 ip 时不参与判重", () => {
  const devices = makeDevices([{ deviceId: "noip" }]);
  const remote = [{ deviceId: "noip", ip: 30 }];
  const out = filterRemoteClients(devices, remote, 999);
  // 本地该设备没有虚拟 IP，未登记；远端有 IP 故保留
  assert.deepEqual(out.map((r) => r.ip), [30]);
});

test("空输入应返回空数组", () => {
  assert.deepEqual(filterRemoteClients(makeDevices([]), [], 1), []);
  assert.deepEqual(filterRemoteClients(makeDevices([]), undefined, 1), []);
  assert.deepEqual(filterRemoteClients(makeDevices([]), null, 1), []);
});
