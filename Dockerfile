# 阶段一：安装依赖。
# 使用 slim 变体而非完整 bookworm，去掉完整发行版中用不到的编译工具链与文档。
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# 只拷贝依赖清单，最大化利用 Docker 层缓存。
#
# 关于 optionalDependencies 的取舍（重要）：
# workerd 与 esbuild 的**平台原生二进制**都以 optionalDependencies 形式分发：
#   @cloudflare/workerd-linux-64 / -linux-arm64
#   @esbuild/linux-x64 / -linux-arm64
# 若用 --omit=optional 全局排除，这些二进制根本不会装上；workerd 的
# postinstall（install.js）只能联网补装作为兜底，官方明确提示：
#   "This can happen if you use the --no-optional flag. ...
#    If that fails, you need to remove the --no-optional flag to use workerd."
# 交叉构建 arm64 时该兜底不可靠，因此这里**不加** --omit=optional，
# 让 npm 按 os/cpu 自动装上当前平台的二进制；随后再删掉本服务用不到的
# sharp（wrangler 的可选依赖，仅用于图片处理及配套 libvips），
# 既保证原生二进制完整，又保住了体积收益。
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi \
    && rm -rf node_modules/sharp node_modules/@img \
    && npm cache clean --force

# 构建期断言：确认 workerd 原生二进制已就位且可执行。
# 说明：workerd 的 postinstall 会调用 maybeOptimizePackage()，把平台包内的
# 二进制硬链接到 node_modules/workerd/bin/workerd，运行时使用的正是该路径
# （而非 @cloudflare/workerd-linux-* 包内的原始位置）。
# 若此处缺失，说明平台二进制未装上，容器启动必然失败；
# 在构建期断言可让多架构构建立刻暴露问题，而不是拖到运行时。
RUN node -e "\
const fs=require('fs'),path=require('path');\
const p=path.join('node_modules','workerd','bin','workerd');\
if(!fs.existsSync(p)){console.error('[build] 缺少 workerd 可执行文件：'+p);process.exit(1);}\
fs.accessSync(p,fs.constants.X_OK);\
const st=fs.statSync(p);\
if(st.size<1000000){console.error('[build] workerd 可能是占位脚本而非原生二进制，大小='+st.size);process.exit(1);}\
console.log('[build] workerd 原生二进制校验通过（'+process.arch+'，'+Math.round(st.size/1048576)+'MB）');\
"


# 阶段二：运行时镜像。
FROM node:20-bookworm-slim

# slim 变体不含 openssl，而 scripts/wss-proxy.mjs 在本地测试模式下需要它
# 生成自签证书（完整版 bookworm 自带，故原先可正常运行）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖来自上一阶段，镜像层中不含 npm 缓存与构建期临时文件。
# workerd 原生二进制（node_modules/workerd/bin/workerd）已在上一阶段断言过。
COPY --from=deps /app/node_modules ./node_modules

COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY wrangler.toml ./

# src/version.js 在 .gitignore 中不入库，而 src/room.js 会 import 该文件，
# 必须在镜像内生成，否则运行时 import 失败。
# SERVER_COMMIT 由 CI 通过 --build-arg 注入，使镜像内版本号可追溯到具体提交。
ARG SERVER_COMMIT=""
ENV SERVER_COMMIT=${SERVER_COMMIT}
RUN node scripts/gen-version.js

# 构建期预编译 Worker bundle（dist/worker.js）。
# 运行时用 `wrangler dev --no-bundle` 直接加载该产物，跳过每次启动的
# esbuild 打包与 [build] 钩子，缩短容器冷启动时间。
# 必须放在 gen-version 之后：src/version.js 是在上一步生成的，
# 若提前打包会把旧版本号固化进产物。
RUN ./node_modules/.bin/wrangler deploy --dry-run --outdir dist \
    && test -f dist/worker.js

EXPOSE 8787

CMD ["node", "scripts/docker-start.mjs"]
