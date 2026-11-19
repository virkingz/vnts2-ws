import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

if (changed.length) {
  writeFileSync("wrangler.toml", toml);
  console.log(`[vnts2-cf] Docker 启动参数已写入 wrangler.toml：${changed.join(", ")}`);
}

if (process.env.LOCAL_PROTOCOL === "http-wss-proxy") {
  const internalPort = process.env.INTERNAL_PORT || "8786";
  const publicPort = process.env.PUBLIC_PORT || "8787";
  const persistTo = process.env.PERSIST_TO || "";
  console.log(`[vnts2-cf] Docker 本地测试模式：Worker HTTP=${internalPort}，WSS 代理=${publicPort}`);
  if (persistTo) console.log(`[vnts2-cf] Durable Object 状态目录：${persistTo}`);
  const workerArgs = ["dev", "--ip", "0.0.0.0", "--port", internalPort, "--local-protocol", "http"];
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
