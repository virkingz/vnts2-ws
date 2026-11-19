import test from "node:test";
import assert from "node:assert/strict";
import { parsePeerServers } from "../src/room.js";

// 互联接口是容器内明文 HTTP（8786），不带 TLS 证书。
// 误填 https:// 会让 workerd 在 TLS 握手时报
// 「TLS peer's certificate is not trusted」并以 internal error 反复刷日志。
// 下面用例确保这类配置被提前拦截并给出可读错误。

test("合法的 http:// 对端应被保留", () => {
  const r = parsePeerServers("http://203.0.113.20:18786");
  assert.deepEqual(r.peers, ["http://203.0.113.20:18786"]);
  assert.equal(r.errors.length, 0);
});

test("多个对端按逗号分隔，空格与末尾斜杠自动清理", () => {
  const r = parsePeerServers(" http://a:18786/ , http://b:18786// ,, http://c:18786 ");
  assert.deepEqual(r.peers, ["http://a:18786", "http://b:18786", "http://c:18786"]);
  assert.equal(r.errors.length, 0);
});

test("https:// 对端应被剔除并给出配置错误", () => {
  const r = parsePeerServers("https://203.0.113.20:18786");
  assert.deepEqual(r.peers, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /https:\/\//);
  assert.match(r.errors[0], /18786/);
});

test("混合配置时仅保留 http 项，https 项单独报错", () => {
  const r = parsePeerServers("http://ok:18786,https://bad:18786");
  assert.deepEqual(r.peers, ["http://ok:18786"]);
  assert.equal(r.errors.length, 1);
});

test("缺少 http:// 前缀应被剔除并给出配置错误", () => {
  const r = parsePeerServers("203.0.113.20:18786");
  assert.deepEqual(r.peers, []);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /缺少 http:\/\//);
});

test("空值或空字符串不应产生对端或错误", () => {
  for (const v of ["", "   ", undefined, null, ",,,"]) {
    const r = parsePeerServers(v);
    assert.deepEqual(r.peers, []);
    assert.equal(r.errors.length, 0);
  }
});
