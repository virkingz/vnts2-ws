#!/usr/bin/env bash
# 自动补全对端证书链 —— 解决 workerd 报
#   "self signed certificate in certificate chain"
# 但证书其实是公共 CA 签发的情况。
#
# 成因：服务端（如 EdgeOne 回源、nginx 配置不当）只返回叶子证书、
#       没有随附中间证书。curl / 浏览器 会按 AIA 自动下载中间证书补链，
#       workerd 不会，于是链断被判定为「自签」。
#
# 用法：
#   bash fetch-peer-chain.sh <对端域名>[:端口]
#   例：bash fetch-peer-chain.sh vnts2s.cy.virking.top
#
# 输出：./certs/ca.crt（补链所需的中间/根证书合集）
# 然后设置 NODE_EXTRA_CA_CERTS=/certs/ca.crt 并挂载该文件。

set -uo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "用法: bash fetch-peer-chain.sh <域名>[:端口]" >&2
  exit 1
fi

HOST="${TARGET%%:*}"
PORT="${TARGET##*:}"
if [ "$PORT" = "$TARGET" ] || [ -z "$PORT" ]; then PORT=443; fi

command -v openssl >/dev/null 2>&1 || { echo "需要 openssl" >&2; exit 1; }

OUT_DIR="certs"
OUT_FILE="${OUT_DIR}/ca.crt"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "检查 ${HOST}:${PORT} 的证书链..."

# 一次性取出服务端返回的全部证书
echo | timeout 15 openssl s_client -connect "${HOST}:${PORT}" -servername "$HOST" -showcerts 2>/dev/null \
  | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' > "$TMP/chain.pem" || true

count=$(grep -c "BEGIN CERTIFICATE" "$TMP/chain.pem" 2>/dev/null || echo 0)
echo "服务端返回证书数量: ${count}"

if [ "$count" -ge 2 ]; then
  echo "证书链完整（${count} 个），但 workerd 仍可能因信任库/交叉签名链处理差异而失败。"
  echo "（典型：Let's Encrypt 的 YR1 -> ISRG Root YR -> ISRG Root X1 交叉签名链）"
  echo "做法：把整条链作为额外信任导入 workerd。"
  mkdir -p "$OUT_DIR"
  cp "$TMP/chain.pem" "$OUT_FILE"
  echo "已导出: ${OUT_FILE}"
  echo
  echo "验证该文件能否完成校验："
  echo | timeout 15 openssl s_client -connect "${HOST}:${PORT}" -servername "$HOST" \
    -CAfile "$OUT_FILE" -verify_return_error 2>&1 \
    | grep -E "Verify return code" | sed 's/^/  /' || true
  echo
  cat <<'TIP'
下一步：
  1) docker-compose.yaml 取消注释：  - ./certs/ca.crt:/certs/ca.crt:ro
  2) .env 设置：                     NODE_EXTRA_CA_CERTS=/certs/ca.crt
  3) docker compose up -d
TIP
  exit 0
fi

if [ "$count" -eq 0 ]; then
  echo "TLS 握手失败或未返回证书，请检查端口与连通性。" >&2
  exit 1
fi

echo "仅返回叶子证书，正在按 AIA 补全中间证书..."

mkdir -p "$OUT_DIR"
: > "$OUT_FILE"

current="$TMP/chain.pem"
depth=0
while [ $depth -lt 5 ]; do
  ai_url=$(openssl x509 -in "$current" -noout -text 2>/dev/null \
    | grep -A1 "Authority Information Access" \
    | grep -o 'URI:http[^ ]*' | head -1 | sed 's/^URI://')

  if [ -z "$ai_url" ]; then
    echo "  已到链顶（无更多 AIA）"
    break
  fi

  echo "  下载: $ai_url"
  der="$TMP/step${depth}.der"
  if ! curl -fsSL --max-time 15 "$ai_url" -o "$der"; then
    echo "  下载失败：$ai_url" >&2
    echo "  可手动下载后转 PEM，或用 --cacert 指定该 CA。" >&2
    break
  fi

  pem="$TMP/step${depth}.pem"
  if ! openssl x509 -inform DER -in "$der" -out "$pem" 2>/dev/null; then
    # 有些 AIA 直接返回 PEM
    if ! openssl x509 -in "$der" -out "$pem" 2>/dev/null; then
      echo "  无法解析下载的证书" >&2
      break
    fi
  fi

  subj=$(openssl x509 -in "$pem" -noout -subject 2>/dev/null)
  echo "  得到: ${subj}"
  cat "$pem" >> "$OUT_FILE"

  # 自签根（subject == issuer）则停止
  iss=$(openssl x509 -in "$pem" -noout -issuer 2>/dev/null | sed 's/^issuer=//')
  sj=$(echo "$subj" | sed 's/^subject=//')
  if [ "$sj" = "$iss" ]; then
    echo "  已到自签根，补链结束"
    break
  fi

  current="$pem"
  depth=$((depth + 1))
done

n=$(grep -c "BEGIN CERTIFICATE" "$OUT_FILE" 2>/dev/null || echo 0)
if [ "$n" -eq 0 ]; then
  echo "未能补全证书链。" >&2
  exit 1
fi

echo
echo "已生成 ${OUT_FILE}（${n} 个证书）"
echo
echo "验证补链效果："
if printf '%s\n' "$OUT_FILE" | grep -q .; then
  echo | timeout 15 openssl s_client -connect "${HOST}:${PORT}" -servername "$HOST" \
    -CAfile "$OUT_FILE" 2>&1 | grep -E "Verify return code" | sed 's/^/  /' || true
fi
echo
cat <<'TIP'
下一步：
  1) docker-compose.yaml 取消注释：  - ./certs/ca.crt:/certs/ca.crt:ro
  2) .env 设置：                     NODE_EXTRA_CA_CERTS=/certs/ca.crt
  3) docker compose up -d

治本建议：让服务端返回完整证书链（叶子+中间）。
  EdgeOne：边缘 HTTPS 证书若为「自定义证书」，重新上传时需要传 fullchain
           （包含中间证书），或改用其免费证书（自动带完整链）。
  nginx：  ssl_certificate 指向 fullchain.pem，而非单张证书。
TIP
