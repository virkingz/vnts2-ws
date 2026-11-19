import tls from "node:tls";

// DER 转 PEM。
export function derToPem(der) {
  const b64 = Buffer.from(der).toString("base64").match(/.{1,64}/g)?.join("\n") || "";
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// 与指定主机握手，取回其下发的完整证书链（按 issuerCertificate 逐级上溯）。
// 返回 DER 数组；自签根的 issuer 指回自身，用 fingerprint 去重防环。
export function fetchChain(host, port = 443, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const chain = [];
        const seen = new Set();
        let cert = socket.getPeerCertificate(true);
        while (cert && cert.raw && !seen.has(cert.fingerprint)) {
          seen.add(cert.fingerprint);
          chain.push(cert.raw);
          cert = cert.issuerCertificate;
        }
        socket.end();
        resolve(chain);
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("连接超时"));
    });
  });
}

// 对多个 https 对端收集证书链，去重后返回 PEM 数组。
// 单个对端失败只影响自身，不影响其他对端。
export async function collectPeerChains(peers, log = console) {
  const unique = new Map();
  for (const peer of peers) {
    let host;
    let port;
    try {
      const u = new URL(peer);
      host = u.hostname;
      port = Number(u.port || 443);
    } catch {
      log.error(`[vnts2-cf] 无法解析的对端地址：${peer}`);
      continue;
    }

    try {
      const ders = await fetchChain(host, port);
      let added = 0;
      for (const der of ders) {
        const key = Buffer.from(der).toString("base64").slice(0, 64);
        if (unique.has(key)) continue;
        unique.set(key, derToPem(der));
        added += 1;
      }
      log.log(`[vnts2-cf] ${host}:${port} 证书链 ${ders.length} 个（新增 ${added} 个）`);
    } catch (error) {
      log.error(
        `[vnts2-cf] 获取 ${host}:${port} 证书链失败：${error.message || String(error)}`
      );
    }
  }
  return Array.from(unique.values());
}
