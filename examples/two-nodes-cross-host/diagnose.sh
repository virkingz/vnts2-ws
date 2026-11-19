#!/usr/bin/env bash
# vnts2-ws 连接诊断脚本（在服务端主机上运行）
#
# 用法：
#   bash diagnose.sh                # 默认 WSS 端口 8787、互联端口 8786
#   bash diagnose.sh 8787 18786     # 自定义端口
#
# 用于排查「客户端无法连接服务端」。

set -uo pipefail

WSS_PORT="${1:-8787}"
PEER_PORT="${2:-8786}"

FAILED=0
pass() { printf '  [OK]   %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; FAILED=1; }
info() { printf '  [INFO] %s\n' "$1"; }

echo "=== 1. 容器状态 ==="
NAME=""
if command -v docker >/dev/null 2>&1; then
  NAME=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i vnts2 | head -1)
  if [ -n "$NAME" ]; then
    docker ps --format '  {{.Names}} | {{.Status}} | {{.Ports}}' | grep -i vnts2
    pass "容器 $NAME 在运行"
  else
    fail "未发现运行中的 vnts2 容器，请先 docker compose up -d"
  fi
else
  fail "未找到 docker 命令"
fi

echo
echo "=== 2. 宿主机端口监听 ==="
for p in "$WSS_PORT" "$PEER_PORT"; do
  listening=0
  if command -v ss >/dev/null 2>&1; then
    ss -lnt 2>/dev/null | grep -q ":$p " && listening=1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -lnt 2>/dev/null | grep -q ":$p " && listening=1
  fi
  if [ "$listening" = "1" ]; then
    pass "端口 $p 正在监听"
  else
    fail "端口 $p 未监听（检查 compose 的 ports 映射）"
  fi
done

echo
echo "=== 3. 从本机访问 WSS 接口（客户端走的就是这个）==="
TMPJSON=$(mktemp)
if curl -sk --max-time 5 "https://127.0.0.1:${WSS_PORT}/test?format=json" > "$TMPJSON" 2>/dev/null; then
  if grep -q '"WebSocket服务":"正常"' "$TMPJSON"; then
    pass "WSS 接口正常"
    info "响应：$(head -c 320 "$TMPJSON")"
  else
    fail "WSS 接口返回异常：$(head -c 200 "$TMPJSON")"
  fi
else
  fail "无法访问 https://127.0.0.1:${WSS_PORT}/test（TLS 或代理未就绪）"
fi
rm -f "$TMPJSON"

echo
echo "=== 4. 互联端口（供对端节点访问）==="
if curl -s --max-time 5 "http://127.0.0.1:${PEER_PORT}/test?format=json" >/dev/null 2>&1; then
  pass "互联端口 ${PEER_PORT} 可用（明文 HTTP）"
else
  fail "互联端口 ${PEER_PORT} 不可用"
fi

echo
echo "=== 5. 生效的配置（重点看白名单与互联开关）==="
if [ -n "$NAME" ]; then
  for v in NETWORKS SERVER_TOKEN PEER_SERVERS PERSIST_TO; do
    val=$(docker exec "$NAME" printenv "$v" 2>/dev/null)
    if [ -z "${val:-}" ]; then
      info "$v = （空）"
    else
      info "$v = $val"
    fi
  done
  if [ -z "$(docker exec "$NAME" printenv SERVER_TOKEN 2>/dev/null)" ]; then
    fail "SERVER_TOKEN 为空 -> /peer 互联接口未启用"
  fi
  if [ -z "$(docker exec "$NAME" printenv PEER_SERVERS 2>/dev/null)" ]; then
    fail "PEER_SERVERS 为空 -> 未配置互联对端"
  fi
fi

echo
echo "=== 6. 容器最近日志 ==="
if [ -n "$NAME" ]; then
  docker logs "$NAME" --tail 25 2>&1 | sed 's/^/  /'
else
  info "无容器，跳过"
fi

echo
if [ "$FAILED" = "0" ]; then
  echo "结论：服务端自身正常。若客户端仍连不上，问题在客户端参数或网络路径，"
  echo "      请核对：地址是否为 wss://、端口是否为 ${WSS_PORT}、"
  echo "      网络编号是否在白名单内、是否加了 --cert-mode skip。"
else
  echo "结论：服务端存在问题，见上方 [FAIL] 项。"
fi
