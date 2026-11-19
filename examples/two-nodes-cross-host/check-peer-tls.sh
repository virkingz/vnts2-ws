#!/usr/bin/env bash
# 检查 PEER_SERVERS 中每个对端的证书类型与可达性。
#
# 用法（在服务端主机上执行）：
#   bash check-peer-tls.sh              # 自动找 vnts2 容器
#   bash check-peer-tls.sh vnts2-a      # 指定容器名
#
# 解决什么问题：
#   workerd 报 "self signed certificate in certificate chain" 时，
#   需要判断对端证书是「公共 CA」还是「Cloudflare Origin CA（自签根）」。
#   前者 workerd 直接信任；后者需要把 CA 交给 NODE_EXTRA_CA_CERTS。
#   同时确认域名是否真的解析到了 Cloudflare 边缘。

set -uo pipefail

CONTAINER="${1:-}"
if [ -z "$CONTAINER" ]; then
  CONTAINER=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -i vnts2 | head -1 || true)
fi
if [ -z "$CONTAINER" ]; then
  echo "未找到 vnts2 容器，请手动指定：" >&2
  echo "  bash check-peer-tls.sh <容器名>" >&2
  exit 1
fi

echo "容器: $CONTAINER"

PEERS=$(docker exec "$CONTAINER" printenv PEER_SERVERS 2>/dev/null || true)
if [ -z "$PEERS" ]; then
  echo "PEER_SERVERS 为空，无需检查互联证书。"
  exit 0
fi

echo "PEER_SERVERS = $PEERS"
echo

need_ca=0
IFS=',' read -ra list <<< "$PEERS"
for raw in "${list[@]}"; do
  peer=$(echo "$raw" | tr -d ' ' | sed 's:/*$::')
  [ -z "$peer" ] && continue

  scheme="${peer%%://*}"
  rest="${peer#*://}"
  host="${rest%%:*}"
  port="${rest##*:}"
  if [ "$port" = "$rest" ] || [ -z "$port" ]; then
    [ "$scheme" = "https" ] && port=443 || port=80
  fi

  echo "===== $peer ====="

  if [ "$scheme" = "http" ]; then
    echo "  协议: HTTP（明文，不涉及证书）"
    if command -v curl >/dev/null 2>&1; then
      if curl -s -o /dev/null --max-time 8 "http://${host}:${port}/test?format=json"; then
        echo "  连通性: 正常"
      else
        echo "  连通性: 失败（检查端口/防火墙）"
      fi
    fi
    echo
    continue
  fi

  # https：先看 DNS 解析，判断是否走了 Cloudflare
  if command -v getent >/dev/null 2>&1; then
    ips=$(getent hosts "$host" | awk '{print $1}' | tr '\n' ' ')
    echo "  DNS 解析: ${ips:-未解析}"
  fi

  if ! command -v openssl >/dev/null 2>&1; then
    echo "  未安装 openssl，跳过证书检查"
    echo
    continue
  fi

  cert_info=$(echo | timeout 10 openssl s_client -connect "${host}:${port}" -servername "$host" 2>/dev/null)
  if [ -z "$cert_info" ]; then
    echo "  TLS 握手: 失败（端口不通或被拦截）"
    echo
    continue
  fi

  issuer=$(echo "$cert_info" | openssl x509 -noout -issuer -subject 2>/dev/null)
  echo "  $issuer" | sed 's/^/  /'

  if echo "$issuer" | grep -qi "CloudFlare Origin SSL"; then
    echo "  >>> 判定: Cloudflare Origin Certificate（根为自签 CA）"
    echo "      workerd 不信任，需要配置 NODE_EXTRA_CA_CERTS"
    echo "      或让流量真正经过 Cloudflare 边缘"
    need_ca=1
  elif echo "$issuer" | grep -qi "self"; then
    echo "  >>> 判定: 自签证书，需要配置 NODE_EXTRA_CA_CERTS"
    need_ca=1
  else
    echo "  >>> 判定: 公共 CA 证书，workerd 应可直接信任"
    echo "      若仍报证书错误，检查证书链是否完整（中间证书是否随附）"
  fi

  # 实际用 curl 验证（与 workerd 的信任模型接近）
  if command -v curl >/dev/null 2>&1; then
    if curl -s -o /dev/null --max-time 10 "https://${host}:${port}/test?format=json"; then
      echo "  curl 校验: 通过（公共信任链可用）"
    else
      rc=$?
      echo "  curl 校验: 失败（curl 退出码 $rc，证书不受信任时通常为 60）"
    fi
  fi
  echo
done

if [ "$need_ca" = "1" ]; then
  echo "结论：存在自签根证书的对端，需要信任其 CA。"
  echo "  Cloudflare Origin CA 可用仓库脚本一键准备："
  echo "    bash fetch-cf-origin-ca.sh"
  echo "  然后设置 NODE_EXTRA_CA_CERTS=/certs/ca.crt 并挂载 ./certs/ca.crt"
else
  echo "结论：未发现自签根证书。若 workerd 仍报错，请把完整日志发回分析。"
fi
