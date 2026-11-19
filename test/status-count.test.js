import test from "node:test";
import assert from "node:assert/strict";
import { countUniqueRemoteClients } from "../src/room.js";

// 背景：/test 页「客户端在线」计数偏大，/room 页正常。
// 成因：/test 的 status() 把本地在线客户端与 peerClientCache 的长度直接相加，
// 而同一台设备同时连多个节点时会在各节点各注册一次，本地与远端各算一次，
// 于是重复计数。/room 的设备列表已去重，故显示正常。
// 修复后 /test 与 /room 共用同一套判重规则。

function devicesOf(list) {
  const m = new Map();
  for (const d of list) m.set(d.deviceId, d);
  return m;
}

test("远端独有设备应计入", () => {
  const devices = devicesOf([{ deviceId: "a", ip: 1 }]);
  const remote = [{ deviceId: "b", ip: 2, online: true }];
  assert.equal(countUniqueRemoteClients(devices, remote), 1);
});

test("本地已有同 deviceId 的远端条目不应计入（多锚点重复注册）", () => {
  const devices = devicesOf([{ deviceId: "dup", ip: 10 }]);
  const remote = [{ deviceId: "dup", ip: 20, online: true }];
  assert.equal(countUniqueRemoteClients(devices, remote), 0);
});

test("多个节点上报同一设备（IP 不同）只计一次", () => {
  const devices = devicesOf([]);
  const remote = [
    { deviceId: "x", ip: 30, online: true },
    { deviceId: "x", ip: 31, online: true }
  ];
  assert.equal(countUniqueRemoteClients(devices, remote), 1);
});

test("对端旧版本无 deviceId 时按 IP 判重", () => {
  const devices = devicesOf([{ deviceId: "a", ip: 10 }]);
  const remote = [{ ip: 10, online: true }, { ip: 11, online: true }];
  assert.equal(countUniqueRemoteClients(devices, remote), 1);
});

test("离线远端客户端不应计入在线数", () => {
  const devices = devicesOf([]);
  const remote = [
    { deviceId: "a", ip: 40, online: true },
    { deviceId: "b", ip: 41, online: false }
  ];
  assert.equal(countUniqueRemoteClients(devices, remote), 1);
});

test("缺 IP 的远端条目应忽略", () => {
  const devices = devicesOf([]);
  const remote = [{ deviceId: "a", ip: 0, online: true }, { ip: undefined, online: true }];
  assert.equal(countUniqueRemoteClients(devices, remote), 0);
});

test("空输入返回 0", () => {
  assert.equal(countUniqueRemoteClients(devicesOf([]), []), 0);
  assert.equal(countUniqueRemoteClients(devicesOf([]), undefined), 0);
  assert.equal(countUniqueRemoteClients(devicesOf([]), null), 0);
});

test("本地设备无 IP 时不参与判重", () => {
  const devices = devicesOf([{ deviceId: "noip" }]);
  const remote = [{ deviceId: "noip", ip: 50, online: true }];
  // 本地没有虚拟 IP，未登记；远端有 IP 故计入
  assert.equal(countUniqueRemoteClients(devices, remote), 1);
});
