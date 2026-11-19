// 此文件由 gen-version.js 自动生成，请勿手动修改
import { execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 获取日期（YYYY-MM-DD）
const now = new Date();
const y = now.getFullYear();
const m = String(now.getMonth() + 1).padStart(2, "0");
const d = String(now.getDate()).padStart(2, "0");
const dateStr = `${y}-${m}-${d}`;

// 尝试获取 git 短哈希。
// 优先使用环境变量 SERVER_COMMIT（CI/Docker 构建时注入，因为镜像内无 .git），
// 其次读取本地 git，最后回退为 nogit。
let hash = String(process.env.SERVER_COMMIT || "").trim();
if (!hash) {
  try {
    hash = execSync("git rev-parse --short HEAD", {
      encoding: "utf-8",
      cwd: join(__dirname, ".."),
      timeout: 3000,
    }).trim();
  } catch {
    // git 不可用，使用备用标记
    hash = "nogit";
  }
}

const version = hash ? `${dateStr}_${hash}` : dateStr;

const content = `// 自动生成，请勿手动修改
export const SERVER_VERSION = ${JSON.stringify(version)};
`;

const outPath = join(__dirname, "..", "src", "version.js");

// 内容未变化时不写文件。
// wrangler.toml 配置了 [build] command = "node scripts/gen-version.js"，
// 而 src/version.js 处于 wrangler 的监视范围内：若无条件重写，
// 会形成「构建 -> 写文件 -> 触发重建 -> 再构建」的无限循环。
if (existsSync(outPath) && readFileSync(outPath, "utf-8") === content) {
  console.log(`[gen-version] SERVER_VERSION = ${version}（无变化，跳过写入）`);
  process.exit(0);
}

writeFileSync(outPath, content, "utf-8");
console.log(`[gen-version] SERVER_VERSION = ${version}`);
