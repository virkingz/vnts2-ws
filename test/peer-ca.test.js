import test from "node:test";
import assert from "node:assert/strict";
import { derToPem } from "../scripts/peer-ca.mjs";

// peer-ca.mjs 负责在容器启动时自动抓取 https 对端的证书链，
// 注入 NODE_EXTRA_CA_CERTS，解决 workerd 对交叉签名链验证失败的问题。
// 网络相关逻辑需真实握手，不适合单测；这里覆盖纯函数部分。

test("derToPem 生成的 PEM 结构正确", () => {
  // 任意字节序列，只验证封装格式
  const der = Buffer.from([0x30, 0x82, 0x01, 0x0a, 0x02, 0x82]);
  const pem = derToPem(der);
  assert.match(pem, /^-----BEGIN CERTIFICATE-----\n/);
  assert.match(pem, /\n-----END CERTIFICATE-----\n$/);
  // 去掉头尾与换行后应能还原原始字节
  const body = pem
    .replace("-----BEGIN CERTIFICATE-----", "")
    .replace("-----END CERTIFICATE-----", "")
    .replace(/\s/g, "");
  assert.deepEqual(Buffer.from(body, "base64"), der);
});

test("derToPem 按 64 字符换行", () => {
  const der = Buffer.alloc(200, 0xab);
  const pem = derToPem(der);
  const lines = pem.split("\n").filter((l) => l && !l.startsWith("-----"));
  assert.ok(lines.length > 1, "较长内容应分成多行");
  for (const line of lines.slice(0, -1)) {
    assert.equal(line.length, 64, "非末行应为 64 字符");
  }
  assert.ok(lines[lines.length - 1].length <= 64);
});

test("derToPem 处理空输入不抛错", () => {
  const pem = derToPem(Buffer.alloc(0));
  assert.match(pem, /BEGIN CERTIFICATE/);
});
