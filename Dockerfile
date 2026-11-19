FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# src/version.js 在 .gitignore 中不入库，且 .dockerignore 会排除它，
# 而 src/room.js 会 import 该文件。必须在镜像内生成，否则运行时 import 失败。
# SERVER_COMMIT 由 CI 通过 --build-arg 注入，使镜像内版本号可追溯到具体提交。
ARG SERVER_COMMIT=""
ENV SERVER_COMMIT=${SERVER_COMMIT}
RUN node scripts/gen-version.js

EXPOSE 8787

CMD ["node", "scripts/docker-start.mjs"]
