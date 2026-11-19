import test from "node:test";
import assert from "node:assert/strict";
import { parsePeerServers } from "../src/room.js";

// PEER_SERVERS 同时支持 http:// 与 https://：
//   http://  -> 直连对端明文互联端口（如 18786），无需证书
//   https:// -> 经反向代理/隧道映射到互联端口，需 workerd 信任该证书
//               （通过 NODE_EXTRA_CA_CERTS 指定 CA）

test("http:// 对端应被保留", () => {
  const r = parsePeerServers("http://203.0.113.20:18786");
  assert.deepEqual(r.peers, ["http://203.0.113.20:18786"]);
  assert.equal(r.errors.length, 0);
});

test("https:// 对端也应被保留（经反代/隧道映射的场景）", () => {
  const r = parsePeerServers("https://peer.example.com");
  assert.deepEqual(r.peers, ["https://peer.example.com"]);
  assert.equal(r.errors.length, 0);
});

test("http 与 https 可混用", () => {
  const r = parsePeerServers("http://203.0.113.20:18786,https://peer-b.example.com");
  assert.deepEqual(r.peers, ["http://203.0.113.20:18786", "https://peer-b.example.com"]);
  assert.equal(r.errors.length, 0);
});

test("多个对端按逗号分隔，空格与末尾斜杠自动清理", () => {
  const r = parsePeerServers(" http://a:18786/ , https://b.example.com// ,, http://c:18786 ");
  assert.deepEqual(r.peers, ["http://a:18786", "https://b.example.com", "http://c:18786"]);
  assert.equal(r.errors.length, 0);
});

test("缺少协议前缀应被剔除并给出配置错误", () => {
  const r = parsePeerServers("203.0.113.20:18786");
  assert.deepEqual(r.peers, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /缺少 http:\/\/ 或 https:\/\//);
});

test("缺前缀项不影响其他合法项", () => {
  const r = parsePeerServers("http://ok:18786,bad.example.com");
  assert.deepEqual(r.peers, ["http://ok:18786"]);
  assert.equal(r.errors.length, 1);
});

test("空值或空字符串不应产生对端或错误", () => {
  for (const v of ["", "   ", undefined, null, ",,,"]) {
    const r = parsePeerServers(v);
    assert.deepEqual(r.peers, []);
    assert.equal(r.errors.length, 0);
  }
});
