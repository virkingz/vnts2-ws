# 阶段一：安装依赖。
# 使用 slim 变体而非完整 bookworm，去掉完整发行版中用不到的编译工具链与文档。
FROM node:20-bookworm-slim AS deps

WORKDIR /app

# 只拷贝依赖清单，最大化利用 Docker 层缓存。
# 注意：wrangler 虽声明在 devDependencies，但运行时靠它模拟 Worker/Durable Object，
# 因此必须完整安装，不能使用 --omit=dev。
# sharp 是 wrangler 的可选依赖（仅用于图片处理），本服务用不到，用 --omit=optional 省去。
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=optional --no-audit --no-fund; \
    else \
      npm install --omit=optional --no-audit --no-fund; \
    fi \
    && npm cache clean --force


# 阶段二：运行时镜像。
FROM node:20-bookworm-slim

# slim 变体不含 openssl，而 scripts/wss-proxy.mjs 在本地测试模式下需要它
# 生成自签证书（完整版 bookworm 自带，故原先可正常运行）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖来自上一阶段，镜像层中不含 npm 缓存与构建期临时文件。
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
