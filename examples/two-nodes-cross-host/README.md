# 两台设备互联部署模板

适用于**两台独立机器**各跑一个 vnts2-ws 节点，两个节点互联互通
（同网络客户端跨节点互相可见，流量可经服务端转发）。

## 文件说明

```
two-nodes-cross-host/
├── node-a/
│   ├── docker-compose.yaml
│   └── .env.example
└── node-b/
    ├── docker-compose.yaml
    └── .env.example
```

两个模板**结构完全相同**，唯一的差别是 `.env` 里的 `PEER_HOST`：

| 节点 | 放在哪台机器 | PEER_HOST 填什么 |
|---|---|---|
| node-a | 第一台 | **node-b** 的地址，如 `http://203.0.113.20:18786` |
| node-b | 第二台 | **node-a** 的地址，如 `http://203.0.113.10:18786` |

> 互相填对方的地址，**切勿填自己**，否则会形成互联环路。

## 部署步骤

两台机器上分别执行（以 node-a 那台为例）：

```bash
# 1. 把 node-a/ 目录下的两个文件拷到目标机器
# 2. 生成互联令牌（两端必须用同一个值）
openssl rand -hex 32

# 3. 配置
cd node-a
cp .env.example .env
vi .env
#    PEER_HOST     = http://<node-b 的 IP>:18786
#    SERVER_TOKEN  = 上一步生成的同一串

# 4. 启动
docker compose up -d
docker compose logs -f
```

在 node-b 那台机器做同样的事，`PEER_HOST` 填 node-a 的地址。

## 客户端连接

节点 A 的客户端：

```bash
sudo ./vnt2_cli -s wss://<node-a 的 IP>:8787 -n office --cert-mode skip
```

节点 B 的客户端：

```bash
sudo ./vnt2_cli -s wss://<node-b 的 IP>:8787 -n lab --cert-mode skip
```

网络编号必须在上方 `NETWORKS` 白名单内，否则会被拒绝：

```
Registration failed: network_code 'xxx' is not allowed by server configuration or database
```

两端节点上的同网络客户端应能互相 ping 通（跨节点流量由服务端互联转发）。

## 端口说明

| 端口 | 用途 | 是否需对外 |
|---|---|---|
| 8787 | 客户端 WSS 接入 | 需对客户端开放 |
| 18786 → 容器 8786 | 节点间互联（明文 HTTP） | **仅需对端节点开放** |

互联端口是**明文 HTTP**，仅靠 `SERVER_TOKEN` 鉴权，因此：

- `SERVER_TOKEN` 必须用足够长的随机串，不要用示例值；
- 建议用防火墙或云安全组把 18786 限制为**仅对端节点 IP** 可访问；
- 若两台机器在同一内网/VPN，把 `PEER_BIND_IP` 设为内网网卡地址，
  `PEER_HOST` 用内网地址，互联流量就不经过公网。

## 常见问题

**互联状态怎么查？**

浏览器打开 `https://<节点IP>:8787/test?format=json`，看
`互联服务端在线` / `互联服务端离线` 字段。或访问 `/peer` 页面查看。

**互联不通，怎么排查？**

1. 两端 `SERVER_TOKEN` 是否**完全一致**（注意多余空格）；
2. `PEER_HOST` 是否为**对方**地址且端口是对方的 `PEER_PORT`；
3. 从 node-a 机器上测试对端端口是否可达：
   `curl http://<node-b 的 IP>:18786/test`
4. 检查防火墙/安全组是否放行了互联端口。

**数据会丢吗？**

不会。`docker-compose.yaml` 已挂载命名卷 `vnts2-data`，
`docker compose down` 后重新 `up`、或拉新镜像重建容器，设备档案仍在。
只有 `docker compose down -v`（显式删卷）才会清空。

**注意**：持久化的是设备档案，不是 WebSocket 连接。
容器重建后连接会断开，客户端会自动重连并复用同一 `device-id`，
从而拿回原来的虚拟 IP。
