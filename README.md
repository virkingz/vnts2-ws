# vnts2-ws — JavaScript 版 vnts2 实现（Cloudflare Worker）

#### [VNT2](https://github.com/vnt-dev/vnt/tree/v2) 是一个简便高效的异地组网、内网穿透工具，源项目使用 Rust 实现。本项目使用 Cloudflare Worker + Durable Object 实现了 JavaScript 版本的 WebSocket [VNTS2](https://github.com/vnt-dev/vnts/tree/v2) 服务端，支持网络中继转发与 P2P 打洞信息交换。

> 本仓库基于 [lmq8267/vnts2-cf](https://github.com/lmq8267/vnts2-cf) 派生，在**保持功能完全不变**的前提下做了一轮代码与框架优化，并增加 CI 自动构建 Docker 镜像。

## 相对上游的改动

功能、接口、配置项、协议行为均保持不变，仅做等价的工程性改进：

**代码清理**
- 删除从未被调用的死代码：`escapeHtml`、`jsonLogResponse`，以及只写不读的 `lastError`。
- 修正 `RELAY_PROBE` 系列消息类型编号重叠问题（原 `RELAY_PROBE_REPLY` 与 `RELAY_PROBE_CLIENT` 同为 18），现对齐上游 `RelayProbe=18` / `RelayProbeReply=19`。
- 抽出 `PROJECT_URL` 常量（原硬编码分散 4 处）与统一的 `toBeijingTime()`（原重复实现 3 次）。
- 补充 `.dockerignore`，避免把测试二进制（约 5.8 MB）与截图打入生产镜像。

**性能**
- `ProtoWriter` 由「数组逐字节 push」改为定长 `Uint8Array` 缓冲 + 按需扩容，转发大包时避免百万次逐字节写入。
- `readPacket` 的 payload 由 `slice` 拷贝改为 `subarray` 零拷贝视图。
- 互联节点客户端列表拉取由**逐个串行**改为 `Promise.all` 并发，消除最坏 N×15s 的串行等待。
- 互联缓存变更签名由全量 `JSON.stringify` 改为轻量字符串拼接。
- `getClientIp` 不再遍历全部请求头构建对象。
- `/test` 状态统计增加 1 秒短 TTL 缓存。

**新增配置**
- `TEST_PASSWORD`：可选地为 `/test` 状态页加访问密码；**留空时行为与原来完全一致（公开）**。
- 提供 `docker-compose.yaml` 示例：双节点互联 + `NETWORKS` 网络白名单。
- 修复 `docker-start.mjs` 环境变量透传白名单缺失 `TEST_PASSWORD` / `GATEWAY` / `GATEWAY_NAME`
  （原先从 Docker 传入这些配置会静默失效）。

**安全加固**
- 认证 Cookie（`log_auth`、`peer_auth`）改为 `HttpOnly` + `Secure`，前端不再能通过脚本读取口令。
- 新增 `/logout` 统一登出入口，由服务端下发过期 Cookie（HttpOnly 后前端无法自行清除）。
- 令牌比对由 `===` 改为恒定时间比较，避免通过响应耗时推断密钥。

**构建与 CI**
- `Dockerfile` 内自动生成 `src/version.js`（该文件不入库，原镜像会因 import 失败而无法启动）。
- 镜像改为多阶段构建 + `node:20-bookworm-slim`，并跳过可选依赖 `sharp`，
  体积由约 1.96GB 降至约 480MB（约 75%）。
- 补 `package-lock.json`（原仓库无 lockfile），构建可复现、版本不再漂移。
- 新增 GitHub Actions：运行单测 + 真实拉起容器做启动冒烟测试 + 构建镜像推送到 GHCR，
  镜像内版本号可通过 `SERVER_COMMIT` 追溯到具体提交。

## 目录

- [UI预览](#ui预览)
- [项目关系](#项目关系)
- [功能对比](#功能对比)
- [必须使用 WSS 连接](#必须使用-wss-连接)
  - [IPv6 DNS 解析问题](#ipv6-dns-解析问题)
- [已实现功能](#已实现功能)
- [页面预览](#页面预览)
  - [/test — 服务状态](#test--服务状态)
  - [/room — 房间状态](#room--房间状态需认证)
  - [/log — 操作日志](#log--操作日志需密码)
  - [/peer — 互联服务端](#peer--互联服务端需令牌)
- [与 Rust vnts2 的差异](#与-rust-vnts2-的差异)
- [Cloudflare 部署](#cloudflare-部署)
- [vnt2 客户端示例](#vnt2-客户端示例)
- [Docker Compose 部署（双节点互联 + 网络白名单）](#docker-compose-部署双节点互联--网络白名单)
- [本地 Docker 测试](#本地-docker-测试)
- [基础配置](#基础配置)
  - [配置对照](#配置对照)
  - [Worker 扩展参数](#worker-扩展参数)
- [稳定性和错误处理](#稳定性和错误处理)
- [开发命令](#开发命令)

## UI预览

1. `https://你的CF域名/log`  日志入口，正常使用请勿开启日志，避免消耗额度

![](./img/日志.png)

2. `https://你的CF域名/test` 健康监测入口，查看部署的服务是否正常

![](./img/状态.png)

3. `https://你的CF域名/room` 组网房间入口，查看当前网络编号的组网设备状态

![](./img/房间.png)

4. `https://你的CF域名/peer` 互联服务端入口，查看当前服务端的其他互联服务端状态，建议使用两个CF帐号开启互联，不能与rust vnts2互联

![](./img/互联.png)

## 项目关系

| 项目 | 类型 | 说明 |
|---|---|---|
| [vnt2](https://github.com/vnt-dev/vnt/tree/v2) | 客户端 CLI | 组网客户端，支持 TCP/TLS、QUIC、WSS 连接服务端 |
| [vnts2](https://github.com/vnt-dev/vnts/tree/v2) | 服务端 | Rust 版服务端，支持 TCP/TLS、QUIC、WSS，可自建 |
| **vnts2-cf** 本项目 | 服务端 (CF) | Cloudflare Workers 版服务端，只支持 WSS 客户端入口 |

`vnt2` 客户端 → WSS → `vnts2-cf`（Cloudflare Workers）

> 本项目仅供学习交流和兼容性测试使用。请勿用于非法用途。

## 功能对比

| 功能 | vnts2 (Rust) | vnts2-cf | 说明 |
|---|---|---|---|
| **监听 TCP** | ✅ | ❌ | Worker 不能监听裸 TCP |
| **监听 QUIC** | ✅ | ❌ | Worker 不能监听 UDP/QUIC |
| **监听 WSS** | ✅ | ✅ | Worker 天然支持 HTTPS+WSS |
| **客户端注册** | ✅ | ✅ | 支持普通/预注册模式 |
| **IP 分配** | ✅ | ✅ | 网段由首个客户端 `--ip` 推导 |
| **租约清理** | ✅ | ✅ | 离线超时自动释放 IP |
| **P2P 打洞** | ✅ | ✅ | 服务端协调打洞 |
| **TURN 中转** | ✅ | ✅ | 服务端中转数据 |
| **P2P 专用** | ✅ | ✅ | `DISABLE_RELAY` 禁止中转 |
| **网关 Ping** | ✅ | ✅ | 客户端延迟检测 |
| **客户端列表** | ✅ | ✅ | `vnt2_ctrl clients` RPC |
| **服务端互联** | ✅ (QUIC) | ✅ (HTTPS) | 实现不同服务端互通 |
| **Web 管理页** | ✅ (内置) | ✅ (Worker 页面) | `/test`、`/room`、`/log`、`/peer` |
| **持久化** | ✅ (SQLite) | ✅ (DO Storage) | 设备和 IP 持久化 |
| **操作日志** | ✅ | ✅ | 持久化日志页面 |
| **日志密码保护** | ✅ | ✅ | 未配置不记录日志 |
| **自定义网关 IP** | ✅ | ✅ | `GATEWAY` 环境变量 |
| **自定义节点名** | ✅ | ✅ | `GATEWAY_NAME` 环境变量 |
| **网络编号限制** | ✅ | ✅ | `NETWORKS` 白名单 |
| **仅 WSS 客户端** | 多协议 | 仅 WSS | 客户端必须用 `-wss` |

## 必须使用 WSS 连接

由于 Cloudflare Workers 只接受 HTTPS/WSS 流量，`vnt2` 客户端连接时必须指定 `-wss` 协议和 `:443` 端口：

```bash
sudo ./vnt2_cli -s wss://你的域名:443 -n 你的网络编号
```

不支持的连接方式：
```
❌ ./vnt2_cli -s 你的域名:443 -n 你的网络编号
❌ ./vnt2_cli -s wss://你的域名 -n 你的网络编号
```

### IPv6 DNS 解析问题

如果域名同时解析到 IPv4 和 IPv6 地址，但客户端所在环境没有 IPv6 网络，连接可能失败或超时。建议：

- 写进本机host指定ipv4地址

## 已实现功能

- `vnt2` WSS 客户端注册。
- `vnts2` 注册/控制 protobuf。
- `vnts2` 16 字节数据包头。
- 普通注册和多服务端预注册确认。
- 客户端 IP 分配、租约保留、离线清理。
- 网关 Ping/Pong、客户端 IP 推送。
- `vnt2_ctrl clients` RPC 客户端列表。
- 服务端网关节点在 `vnt2_ctrl clients` 中作为显示项出现。
- TURN、QUIC、广播、选择性广播中转。
- 仅 P2P 模式，禁止服务端中转。
- `/test`、`/room`、`/log`、`/peer` 中文管理页面。
- 基于 `ServerMessage` protobuf 的 Worker 服务端互联。
- 操作日志持久化到 DO Storage（受 `LOG_PASSWORD` 控制）。
- Docker 端到端测试脚本。

## 页面预览

### `/test` — 服务状态

```
┌──────────────────────────────────────────────────┐
│              vnts2-cf 服务状态                     │
├──────────────────────────────────────────────────┤
│  WebSocket 服务：正常                              │
│  服务版本：2026-06-04_d20e0cc                     │
│  启动时间：2026-06-04 18:30:00                    │
│  已运行：1天2小时30分15秒                          │
│  支持协议：VNT2 WebSocket                         │
│  服务状态：可用                                   │
│  网络编号数：2                                    │
│  服务端中转：已启用                                │
│  互联服务端在线：1 个                              │
│  互联服务端离线：0 个                              │
│  客户端在线：5 个                                  │
│  客户端离线：2 个                                  │
├──────────────────────────────────────────────────┤
│           ┌──────────────┐                       │
│           │   12ms       │   ← 延迟自动检测       │
│           │  连接良好    │                       │
│           └──────────────┘                       │
│           [停止自动检测延迟]                      │
└──────────────────────────────────────────────────┘
```

默认公开访问，无认证。JSON 格式：`/test?format=json`

配置 `TEST_PASSWORD` 后需携带密码：`/test?password=xxx`（未授权返回 401）。

### `/room` — 房间状态（需认证）

```
┌──────────────────────────────────────────────────────────────┐
│  客户端列表                                       [退出]     │
├──────────────────────────────────────────────────────────────┤
│  [5]              [3]              [2]                      │
│  客户端总数       在线客户端       离线客户端                  │
├──────────────────────────────────────────────────────────────┤
│  [全部]  [在线]  [离线]                                       │
├─────────┬────────┬──────┬──────┬────────┬────┬────┬────┬─────┤
│ 虚拟IP↕ │ 主机名  │ 版本  │ 状态  │ 设备ID │加密│上传│下载│上线 │
├─────────┼────────┼──────┼──────┼────────┼────┼────┼────┼─────┤
│10.46.0.1│服务器   │ v... │ 🟢在线│   -    │ -  │ -  │ -  │18:30│
│10.46.0.2│设备A   │ 2.0  │ 🟢在线│ abc123 │ 是 │1MB │2MB │20:30│
│10.46.0.3│设备B   │ 2.0  │ 🔴离线│ def456 │ 否 │5KB │1MB │19:00│
│10.46.0.5│互联     │  -   │ 🟢在线│   -    │ -  │ -  │ -  │  -  │
├─────────┴────────┴──────┴──────┴────────┴────┴────┴────┴─────┤
│ 第 1 / 1 页             [上一页] [下一页]  每页：[10 ▾]       │
└──────────────────────────────────────────────────────────────┘
```

认证方式：`/room?network=网络编号&gateway=网关IP`

> 认证 Cookie `log_auth` / `peer_auth` 已设为 `HttpOnly`，前端脚本无法读取；
> 页面上的「退出」按钮会跳转 `/logout`，由服务端统一清除各认证 Cookie。

- **网关行**（紫色背景）：服务端节点，上线时间为服务端启动时间
- **客户端行**（紫蓝交替）：本机连接的设备，设备ID、加密、流量完整显示
- **互联行**（绿色背景）：其他服务端上的设备，仅显示虚拟IP和状态
- 虚拟IP、上线时间支持正反序排列
- 网关始终在列表第一行

JSON 格式：`/room?format=json&network=xxx&gateway=xxx`

认证成功后写入 cookie，后续可直接访问 `/room`。

### `/log` — 操作日志（需密码）

```
┌──────────────────────────────────────────────────────────────┐
│  服务运行日志 (128)                          [清空日志] [退出] │
├──────────────────────────────────────────────────────────────┤
│  2026-06-04 20:30:15  INFO  注册成功 网络=1234 ...           │
│  2026-06-04 20:28:10  DEBUG 收到 WebSocket 连接 ...          │
│  2026-06-04 20:25:00  ERROR 请求处理失败：...                  │
│  2026-06-04 20:20:33  INFO  客户端离线 ...                    │
│  ...                                                         │
└──────────────────────────────────────────────────────────────┘
                                                        [🔝]
```

认证方式：`/log?password=xxx`

- 日志包含时间（北京时间）、级别（彩色标签）、消息内容
- 保留最近 500 条，持久化到 DO Storage
- `LOG_PASSWORD` 留空时 `/log` 不开放且不记录日志
- 清空日志操作不可恢复
- 登录页有**记住密码**勾选

### `/peer` — 互联服务端（需令牌）

```
┌──────────────────────────────────────────────────────┐
│  互联服务端 (2)                             [退出]    │
├──────────────────────────────────────────────────────┤
│  地址                         │ 状态                  │
├───────────────────────────────┼──────────────────────┤
│  https://server-b.workers.dev│ 🟢 在线               │
│  https://server-c.workers.dev│ 🔴 离线               │
└──────────────────────────────────────────────────────┘
```

认证方式：`/peer?token=互联令牌`

- 仅配置 `SERVER_TOKEN` 后开放
- 状态基于上次定时拉取是否成功，15 秒超时标记离线
- 登录页有**记住令牌**勾选

## 与 Rust vnts2 的差异

`vnts2-cf` 和 Rust `vnts2` 的客户端协议保持兼容，但传输能力受 Cloudflare Workers 限制：

- 客户端入口：实际使用 WSS。
- 不能监听原生 TCP/QUIC。
- 不能直接接入 Rust `vnts2` 的 QUIC peer 互联通道。
- Worker 之间互联使用 HTTPS `/peer/message` 承载 `vnts2/proto/server_message.proto` 的 `ServerMessage` protobuf。
- `forward_data.data` 仍是原始 vnts2 16 字节包头数据。

因此，`vnts2-cf` 与 `vnts2-cf` 之间的互联业务效果和 Rust `vnts2` 互联一致：同步在线客户端、选择 peer 路由、转发原始数据包、避免互联循环。若要与 Rust `vnts2` 直接互联，需要额外桥接 Rust QUIC peer 和 Worker HTTPS peer。

## Cloudflare 部署

1. Fork 本仓库。
2. 登录[Cloudflare Dashboard](https://dash.cloudflare.com)
3. 进入 Workers & Pages → 创建应用程序（Create Application） →  Workers →  链接到github仓库 选择你刚刚fork的仓库，直接部署
4. 绑定自定义域名：打开 Worker 设置 → Triggers(域和路由) → 添加 → Custom Domains(自定义域名)，添加你的域名并保存。
5.vnt2客户端采用 `-s wss://域名:443` 连接

## vnt2 客户端示例

```bash
# 普通连接
sudo ./vnt2_cli -s wss://你的域名:443 -n 你的网络编号 --cert-mode skip

# 强制 IPv4（避免 IPv6 超时）
sudo ./vnt2_cli -4 -s wss://你的域名:443 -n 你的网络编号 --cert-mode skip

# 指定虚拟 IP
sudo ./vnt2_cli -s wss://你的域名:443 -n 你的网络编号 --ip 10.88.0.2 --cert-mode skip

# 控制端口
sudo ./vnt2_cli -s wss://你的域名:443 -n 你的网络编号 --cert-mode skip --ctrl-port 11233
./vnt2_ctrl -p 11233 clients
./vnt2_ctrl -p 11233 route

# 子网输入/输出
sudo ./vnt2_cli -s wss://你的域名:443 -n 你的网络编号 --ip 10.88.0.2 --cert-mode skip -i 172.30.2.0/24,10.88.0.2
sudo ./vnt2_cli -s wss://你的域名:443 -n 你的网络编号t --ip 10.88.0.3 --cert-mode skip -o 172.30.2.0/24
```

## 使用预构建 Docker 镜像

每次推送到 `main` 或打 `v*` 标签，CI 会自动构建镜像并推送到 GitHub Container Registry：

```bash
# 拉取最新镜像
docker pull ghcr.io/virkingz/vnts2-ws:latest

# 单服务端启动
docker run --rm -it -p 8787:8787 \
  -e LOCAL_PROTOCOL=http-wss-proxy \
  -e NETWORKS="" \
  -e LOG_LEVEL=off \
  ghcr.io/virkingz/vnts2-ws:latest
```

客户端连接：

```bash
sudo ./vnt2_cli -s wss://127.0.0.1:8787 -n 你的网络编号 --cert-mode skip
```

> 镜像内已自动生成 `src/version.js`，版本号格式为 `<日期>_<短提交哈希>`，
> 可在 `/test` 页面的「服务端版本」中直接核对当前镜像对应的提交。

### 镜像体积

镜像采用多阶段构建 + `node:20-bookworm-slim` 基础镜像，体积约 **480MB**
（上游单阶段 + 完整 `bookworm` 的写法实测约 **1.96GB**，压缩约 75%）。

体积构成中最大的一块是 `wrangler` 的 `workerd` 运行时（约 102MB）——
本地 Docker 模式靠它模拟 Worker 与 Durable Object，因此不可裁剪。

CI 中的「容器启动冒烟测试」会真实拉起容器并轮询 `/test`，
验证通过后才允许推送镜像，避免发布起不来的镜像。

## Docker Compose 部署（双节点互联 + 网络白名单）

仓库根目录提供 `docker-compose.yaml`，示例启动**两个互联的服务端节点**，
并用 `NETWORKS` 白名单限制客户端可使用的网络编号。

### 启动

```bash
# 强烈建议设置自己的互联令牌（两个节点务必一致）
export SERVER_TOKEN='你的-长-随机-令牌'

docker compose -f docker-compose.yaml up -d
```

如需固定配置，可在同目录建 `.env`：

```dotenv
SERVER_TOKEN=你的-长-随机-令牌
NETWORKS=office,lab
PORT_A=8787
PORT_B=8788
LOG_LEVEL=off
```

### 客户端连接

网络编号**必须在白名单内**，否则服务端会拒绝注册并报
`network_code 'xxx' is not allowed by server configuration or database`：

```bash
# 接入节点 A
sudo ./vnt2_cli -s wss://<主机IP>:8787 -n office --cert-mode skip

# 接入节点 B
sudo ./vnt2_cli -s wss://<主机IP>:8788 -n lab --cert-mode skip

# 不在白名单内 -> 注册被拒
sudo ./vnt2_cli -s wss://<主机IP>:8787 -n notallowed --cert-mode skip
```

两个节点上的同网络客户端会互相可见，跨节点流量由服务端互联转发。

### 关键配置说明

| 项 | 说明 |
|---|---|
| `NETWORKS` | **网络编号白名单**，逗号分隔；留空表示允许任意编号。只限制客户端 `-n`，不影响服务端互联 |
| `SERVER_TOKEN` | 互联共享令牌，**所有互联节点必须配置相同的非空值**；留空会禁用 `/peer` 互联接口 |
| `PEER_SERVERS` | 互联对端地址，**多个用英文逗号分隔**。用容器名指向对方**内部 8786 端口**，严禁填写本节点自身地址 |
| `PORT_A` / `PORT_B` | 两个节点映射到宿主机的 WSS 端口，默认 8787 / 8788 |

#### PEER_SERVERS 填写多个对端

按**英文逗号**分隔，每项都是完整的 `http://<主机>:<对端互联端口>`：

```yaml
# 单个对端
PEER_SERVERS: "http://203.0.113.20:18786"

# 多个对端
PEER_SERVERS: "http://203.0.113.20:18786,http://203.0.113.30:18786,http://node-c.example.com:18786"
```

解析规则（见 `src/room.js`）：按逗号切分，自动去除每项两端空格与末尾斜杠，
空项自动忽略。所以 `a:18786, b:18786/`、`a:18786,,b:18786` 都能正确解析。

注意事项：

- 用**英文逗号**，不要用中文逗号、分号或换行
- 每项必须带 `http://`（互联是明文 HTTP，不是 https）
- 端口填**对端的**互联端口（默认映射为 18786），不是自己的
- **不要填本节点自身地址**，否则形成互联环路
- 所有互联节点的 `SERVER_TOKEN` 必须**完全相同**

拓扑建议：

| 拓扑 | 配置方式 | 适用 |
|---|---|---|
| **星型**（推荐） | 中心节点填写全部边缘节点；边缘节点只填中心节点 | 节点数多、链路最少、便于排查 |
| 全网状 | 每个节点填写其余全部节点（N 个节点各填 N-1 项） | 单点故障容忍，但链路与流量成倍增加 |


### 互联实现要点

Worker 由 `wrangler dev` 以**纯 HTTP** 监听容器内 `8786` 端口，节点之间通过
`PEER_SERVERS` 访问对方的 `8786` 完成 `ClientInfo` / `ForwardData` 同步。
因此互联走的是容器网络内的明文 HTTP，**不经过 8787 的 WSS 端口，也不需要 TLS 证书**。

Compose 默认网络自带 DNS，直接用容器名（`vnts2-a` / `vnts2-b`）即可互相解析。
若跨主机部署，把 `PEER_SERVERS` 改成对端可达的 `http://<主机IP>:<映射端口>`，
并确保该内部端口**不要**直接暴露到公网（互联接口仅靠 `SERVER_TOKEN` 鉴权）。

CI 中的「Compose 互联与白名单验证」会实际启动双节点，验证四件事：
未授权编号被拒绝、授权编号可注册、跨节点 ping 连通、
**容器重建后 DO 数据仍在**。

### 数据持久化

Durable Object 的状态（设备档案、IP 分配、流量统计、上线时间）默认写在容器内的
`/app/.wrangler/state`，容器一旦被重建就会**全部丢失**。compose 已挂载命名卷避免该问题：

| 操作 | 数据 |
|---|---|
| `docker compose restart` / `stop` + `start` | 保留 |
| `docker compose down` 后 `up` | **保留**（卷未删除） |
| `docker compose up -d --force-recreate` / 换镜像重建 | **保留** |
| `docker compose down -v`（显式删卷） | 丢失 |

实现方式：容器内 `PERSIST_TO=/data`，两个节点各挂一个独立命名卷
（`vnts2-a-data` / `vnts2-b-data`），由 `docker-start.mjs` 透传给
`wrangler dev --persist-to`。

> ⚠️ 两个节点**必须各用各的卷**。共用同一个卷会因 sqlite 文件冲突导致数据损坏。

备份与恢复：

```bash
# 备份节点 A 的状态卷
docker run --rm -v vnts2-a-data:/d -v "$PWD":/b alpine \
  tar czf /b/vnts2-a-data.tgz -C /d .

# 恢复（先停容器）
docker compose down
docker run --rm -v vnts2-a-data:/d -v "$PWD":/b alpine \
  sh -c 'rm -rf /d/* && tar xzf /b/vnts2-a-data.tgz -C /d'
docker compose up -d
```

若只想从零开始，`docker compose down -v` 即可清空所有持久化数据。

**注意区分**：持久化的是**设备档案**，不是 WebSocket 连接本身。
容器重建或 DO 休眠后，所有连接都会断开，需要客户端自行重连
（`vnt2_cli` 会自动重连并复用同一 `device-id`，因此重连后能拿回原来的虚拟 IP）。
设备列表里离线设备在 `LEASE_DURATION`（默认 86400 秒）内仍会保留展示，
超时后由维护任务清理。

## 本地 Docker 测试

单服务端启动：

```bash
cd vnts2-ws
sudo docker build -t vnts2-ws .
sudo docker run --rm -it -p 8787:8787 \
  -e LOCAL_PROTOCOL=http-wss-proxy \
  -v "$(pwd)":/app -v /app/node_modules \
  vnts2-ws
```

客户端连接：

```bash
sudo ./vnt2_cli -s wss://127.0.0.1:8787 -n 你的网络编号 --cert-mode skip
```

Docker 端到端测试：

```bash
cd vnts2-cf
printf '管理员密码\n' | npm run docker:e2e
```

## 基础配置

编辑 `wrangler.toml` 的 `[vars]`，详见文件内注释说明。

### 配置对照

Rust `vnts2` 配置字段和 `vnts2-cf` 环境变量对照：

| Rust vnts2 | vnts2-cf | 说明 |
| --- | --- | --- |
| `tcp_bind` | 不支持 | Worker 不能监听裸 TCP |
| `quic_bind` | 不支持 | Worker 不能监听 QUIC |
| `ws_bind` | 不支持 | Worker/Wrangler 入口由平台决定 |
| `cert` / `key` | 不支持 | TLS 由 Cloudflare 平台处理 |
| `white_list` | 不支持 | `NETWORKS` 只限制网络编号 |
| `lease_duration` | `LEASE_DURATION` | 离线租约秒数 |
| `web_bind` | 不支持 | Worker 用 `/test`、`/room`、`/log`、`/peer` |
| `username` / `password` | 不支持 | 页面使用 network+gateway 或 `LOG_PASSWORD` |
| `persistence` | 固定启用 | DO Storage 固定可用 |
| `server_quic_bind` | 不支持 | Worker 不能监听 QUIC peer |
| `peer_servers` | `PEER_SERVERS` | Worker peer 地址 |
| `server_token` | `SERVER_TOKEN` | peer 共享令牌 |
| `custom_nets` | 不支持 | 网段由首个客户端 `--ip` 推导 |
| `network_secrets` | 不支持 | 客户端密码不参与服务端校验 |

### Worker 扩展参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `NETWORKS` | 空（允许所有） | 允许的网络编号白名单 |
| `GATEWAY` | `10.46.0.1` | 默认网关 IP |
| `GATEWAY_NAME` | `服务器` | 页面中服务端节点名称 |
| `LOCATION_HINT` | `apac` | DO 位置提示，降低延迟 |
| `MAINTENANCE_INTERVAL` | `15` | 维护周期（秒） |
| `DISABLE_RELAY` | `0` | 禁止服务端中转 |
| `LOG_LEVEL` | `off`（wrangler.toml 默认） | 日志级别，可选 `info` / `debug` / `off` |
| `LOG_PASSWORD` | 空 | 日志页面密码，未配置不记录日志 |
| `TEST_PASSWORD` | 空 | `/test` 状态页密码，未配置时完全公开 |
| `PEER_SERVERS` | 空 | 互联服务端地址列表 |
| `SERVER_TOKEN` | 空 | 互联共享令牌 |
| `SERVER_VERSION` | 自动生成 | 版本号（部署时自动生成） |

## 稳定性和错误处理

- HTTP、peer 和 Durable Object 请求入口都有异常边界，内部错误会返回错误响应并记录日志。
- 单个客户端的畸形消息、发送失败或连接错误只关闭对应会话，不影响其他客户端。
- alarm 维护任务失败会记录错误，并继续尝试调度下一次维护。
- 损坏的持久化网络或设备记录会被跳过，不会阻止 Durable Object 初始化。
- WebSocket 和 peer 单条输入消息最大为 1 MiB；protobuf 输出最大为 2 MiB。
- 单个 Durable Object 最多保留 1024 个会话、1024 个网络和 4096 个设备记录。
- 租约过期并且没有互联客户端的空网络会自动删除。

## 开发命令

```bash
npm test          # 运行测试
npm run gen-version # 生成版本号
npm run dev       # 本地开发
npm run deploy    # 部署到 Cloudflare
npm run tail      # 查看日志
npm run docker:e2e # Docker 端到端测试
```

## 免责声明

本项目仅供学习交流使用。使用本项目代码所产生的任何后果，均由使用者自行承担。作者不对使用本项目代码可能引起的任何直接或间接损害负责。
