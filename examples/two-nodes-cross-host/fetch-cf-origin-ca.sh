#!/usr/bin/env bash
# 下载 Cloudflare Origin CA 根证书，供 NODE_EXTRA_CA_CERTS 使用。
#
# 适用场景：你的 https 域名由 Cloudflare Origin Certificate 提供服务，
# 而 workerd 直连时因证书链的根是自签 CA 而报：
#   failed: TLS peer's certificate is not trusted,
#   reason = self signed certificate in certificate chain
#
# 用法（在 node-a/ 或 node-b/ 目录下执行）：
#   bash fetch-cf-origin-ca.sh
#   # 生成 ./certs/ca.crt（同时包含 RSA 与 ECC 两个根）
#
# 然后：
#   1) docker-compose.yaml 中取消注释 CA 挂载：
#        - ./certs/ca.crt:/certs/ca.crt:ro
#   2) .env 中设置：
#        NODE_EXTRA_CA_CERTS=/certs/ca.crt
#   3) docker compose up -d
#
# 注意：若对端用的是公共 CA 证书（Edge / Let's Encrypt 等），不需要本脚本。

set -euo pipefail

RSA_URL="https://developers.cloudflare.com/ssl/static/origin_ca_rsa_root.pem"
ECC_URL="https://developers.cloudflare.com/ssl/static/origin_ca_ecc_root.pem"
OUT_DIR="certs"
OUT_FILE="${OUT_DIR}/ca.crt"

command -v curl >/dev/null 2>&1 || { echo "需要 curl，请先安装" >&2; exit 1; }

mkdir -p "$OUT_DIR"

echo "下载 Cloudflare Origin CA 根证书..."
rm -f "$OUT_FILE"
if ! curl -fsSL "$RSA_URL" >> "$OUT_FILE"; then
  echo "RSA 根证书下载失败：$RSA_URL" >&2
  exit 1
fi
if ! curl -fsSL "$ECC_URL" >> "$OUT_FILE"; then
  echo "ECC 根证书下载失败：$ECC_URL" >&2
  exit 1
fi

count=$(grep -c "BEGIN CERTIFICATE" "$OUT_FILE" || true)
if [ "${count:-0}" -lt 2 ]; then
  echo "生成的文件中未包含预期的 2 个证书（实际 ${count:-0} 个），请检查网络" >&2
  exit 1
fi

echo "已生成 ${OUT_FILE}（包含 ${count} 个根证书）"
echo
if command -v openssl >/dev/null 2>&1; then
  echo "证书主题预览："
  openssl crl2pkcs7 -nocrl -certfile "$OUT_FILE" 2>/dev/null \
    | openssl pkcs7 -print_certs -noout 2>/dev/null \
    | grep -E "^subject" | sed 's/^/  /' || true
  echo
fi

cat <<'TIP'
接下来：
  1) docker-compose.yaml 中取消注释：  - ./certs/ca.crt:/certs/ca.crt:ro
  2) .env 中设置：                     NODE_EXTRA_CA_CERTS=/certs/ca.crt
  3) docker compose up -d
启动日志应出现「已加载额外 CA 证书：/certs/ca.crt」。
TIP
