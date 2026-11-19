import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { collectPeerChains } from "./peer-ca.mjs";

// workerd 默认不信任自签证书。当 PEER_SERVERS 使用 https:// 且对端为自签证书时，
// 需通过 NODE_EXTRA_CA_CERTS 指向 CA 证书，wrangler 会把它传给 workerd。
// 这里做一层校验：文件不存在就明确报错，为空则移除，避免 Node 拿空路径去加载。
const extraCa = String(process.env.NODE_EXTRA_CA_CERTS || "").trim();
if (!extraCa) {
  delete process.env.NODE_EXTRA_CA_CERTS;
} else if (!existsSync(extraCa)) {
  console.error(`[vnts2-cf] NODE_EXTRA_CA_CERTS 指向的文件不存在：${extraCa}`);
  console.error("[vnts2-cf] 互联使用 https:// 自签证书时需要该 CA 文件；若互联走 http:// 可忽略此项。");
  delete process.env.NODE_EXTRA_CA_CERTS;
} else {
  process.env.NODE_EXTRA_CA_CERTS = extraCa;
  console.log(`[vnts2-cf] 已加载额外 CA 证书：${extraCa}`);
}

const configurableVars = [
  "NETWORKS",
  "LEASE_DURATION",
  "SERVER_VERSION",
  "GATEWAY",
  "GATEWAY_NAME",
  "LOCATION_HINT",
  "PEER_SERVERS",
  "SERVER_TOKEN",
  "MAINTENANCE_INTERVAL",
  "LOG_LEVEL",
  "LOG_PASSWORD",
  "TEST_PASSWORD",
  "DISABLE_RELAY"
];

let toml = readFileSync("wrangler.toml", "utf8");
const changed = [];

for (const key of configurableVars) {
  if (!Object.prototype.hasOwnProperty.call(process.env, key)) continue;
  const value = escapeTomlString(process.env[key] ?? "");
  const pattern = new RegExp(`^${key}\\s*=\\s*".*"$`, "m");
  const line = `${key} = "${value}"`;
  if (pattern.test(toml)) toml = toml.replace(pattern, line);
  else toml = toml.replace(/\[vars\]\n/, `[vars]\n${line}\n`);
  changed.push(key);
}

// 若构建期已打好 bundle（Dockerfile 中 wrangler deploy --dry-run 产出），
// 则把入口指向它，运行时配合 --no-bundle 跳过每次启动的 esbuild 打包与
// [build] 钩子，缩短冷启动。源码开发模式（无 dist）仍走原路径。
const prebuiltBundle = "dist/worker.js";
const usePrebuilt = existsSync(prebuiltBundle);
if (usePrebuilt && /^main\s*=\s*".*"$/m.test(toml)) {
  toml = toml.replace(/^main\s*=\s*".*"$/m, `main = "${prebuiltBundle}"`);
  if (!changed.includes("main")) changed.push("main");
  console.log(`[vnts2-cf] 检测到预编译产物，入口改为 ${prebuiltBundle}（跳过运行时打包）`);
}

if (changed.length) {
  writeFileSync("wrangler.toml", toml);
  console.log(`[vnts2-cf] Docker 启动参数已写入 wrangler.toml：${changed.join(", ")}`);
}

// 自动信任 https 对端的证书链。
// 背景：workerd 的 BoringSSL 对某些交叉签名链（典型如 Let's Encrypt
// YR1 -> ISRG Root YR -> ISRG Root X1）验证会失败，报
//   "self signed certificate in certificate chain"
// 而同一张证书用 curl/浏览器访问却正常。属于实现差异，不是证书缺陷。
// 做法：启动时主动与每个 https 对端握手，取回它实际下发的整条链，
// 写入临时 PEM 并通过 NODE_EXTRA_CA_CERTS 交给 wrangler/workerd。
// 用户只需更新镜像即可，无需手工准备或挂载 CA 文件。
const httpsPeers = String(process.env.PEER_SERVERS || "")
  .split(",")
  .map((v) => v.trim().replace(/\/+$/, ""))
  .filter((v) => /^https:\/\//i.test(v));

if (httpsPeers.length) {
  console.log(`[vnts2-cf] 检测到 ${httpsPeers.length} 个 https 对端，正在获取其证书链...`);
  try {
    const pemList = await collectPeerChains(httpsPeers);
    if (pemList.length) {
      const caPath = "/tmp/vnts2-peer-ca.pem";
      // 若用户手工指定了 CA，则一并保留，避免覆盖其配置。
      const manual =
        extraCa && existsSync(extraCa) ? readFileSync(extraCa, "utf-8") : "";
      writeFileSync(caPath, manual + pemList.join(""), "utf-8");
      process.env.NODE_EXTRA_CA_CERTS = caPath;
      console.log(
        `[vnts2-cf] 已写入对端证书链（${pemList.length} 个证书）到 ${caPath}，` +
          "并将其设为 NODE_EXTRA_CA_CERTS"
      );
    } else {
      console.log("[vnts2-cf] 未获取到任何对端证书，沿用默认信任库");
    }
  } catch (error) {
    console.error(
      `[vnts2-cf] 自动获取对端证书链失败：${error.message || String(error)}；沿用默认信任库`
    );
  }
}

if (process.env.LOCAL_PROTOCOL === "http-wss-proxy") {
  const internalPort = process.env.INTERNAL_PORT || "8786";
  const publicPort = process.env.PUBLIC_PORT || "8787";
  const persistTo = process.env.PERSIST_TO || "";
  console.log(`[vnts2-cf] Docker 本地测试模式：Worker HTTP=${internalPort}，WSS 代理=${publicPort}`);
  if (persistTo) console.log(`[vnts2-cf] Durable Object 状态目录：${persistTo}`);
  const workerArgs = ["dev", "--ip", "0.0.0.0", "--port", internalPort, "--local-protocol", "http"];
  // 已预编译时跳过打包，直接用 dist/worker.js 启动。
  if (usePrebuilt) workerArgs.push("--no-bundle");
  // 指定持久化目录，使其落在挂载卷内，容器重建后仍可读回。
  // 未设置 PERSIST_TO 时沿用 wrangler 默认的 .wrangler/state（容器内，重建即丢失）。
  if (persistTo) workerArgs.push("--persist-to", persistTo);
  const worker = spawn("./node_modules/.bin/wrangler", workerArgs, {
    stdio: "inherit"
  });
  const proxy = spawn("node", ["scripts/wss-proxy.mjs"], {
    stdio: "inherit",
    env: { ...process.env, BACKEND_PORT: internalPort, PROXY_PORT: publicPort }
  });
  const stop = (code = 0) => {
    worker.kill("SIGTERM");
    proxy.kill("SIGTERM");
    process.exit(code);
  };
  worker.on("exit", (code) => stop(code ?? 0));
  proxy.on("exit", (code) => stop(code ?? 0));
} else {
  execFileSync("npm", ["run", "dev"], { stdio: "inherit" });
}

function escapeTomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
