#!/usr/bin/env bash
# Instala o Call Center Dialer numa central FreePBX 17 / Asterisk.
# Correr como root NA CENTRAL, dentro da pasta do projeto:   sudo bash install.sh
# Idempotente: pode correr outra vez para atualizar o código (não mexe na config nem nos dados).
set -euo pipefail

DEST=/opt/callcenter-dialer
AST=/etc/asterisk
SRC="$(cd "$(dirname "$0")" && pwd)"
TS=$(date +%Y%m%d-%H%M%S)

[ "$(id -u)" = 0 ] || { echo "Correr como root."; exit 1; }
command -v node >/dev/null || { echo "Node.js não encontrado. Instalar Node 18+ (apt install nodejs)."; exit 1; }
NODEV=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODEV" -ge 18 ] || { echo "Node $NODEV é antigo — precisa de 18 ou mais recente."; exit 1; }
command -v asterisk >/dev/null || { echo "Asterisk não encontrado nesta máquina."; exit 1; }

echo "→ A copiar código para $DEST"
mkdir -p "$DEST/public"
cp "$SRC/server.js" "$SRC/ami.js" "$SRC/package.json" "$DEST/"
cp "$SRC/public/index.html" "$DEST/public/"

if [ ! -f "$DEST/config.json" ]; then
  SENHA=$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
  AMISECRET=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  cat > "$DEST/config.json" <<EOF
{
  "porta": 8089,
  "host": "0.0.0.0",
  "senha": "$SENHA",
  "contexto": "callcenter-dialer",
  "dados": "$DEST/dados.json",
  "ami": { "host": "127.0.0.1", "port": 5038, "user": "callcenter", "pass": "$AMISECRET" }
}
EOF
  chmod 600 "$DEST/config.json"
  echo "→ config.json criado (senha do painel: $SENHA)"
else
  AMISECRET=$(node -p "require('$DEST/config.json').ami.pass")
  echo "→ config.json já existe — mantido"
fi

if ! grep -q '^\[callcenter\]' "$AST/manager_custom.conf" 2>/dev/null; then
  echo "→ A criar utilizador AMI 'callcenter' (backup: manager_custom.conf.$TS)"
  [ -f "$AST/manager_custom.conf" ] && cp -p "$AST/manager_custom.conf" "$AST/manager_custom.conf.$TS"
  sed "s/TROCAR-SEGREDO-AMI/$AMISECRET/" "$SRC/asterisk/manager_custom.conf" >> "$AST/manager_custom.conf"
  asterisk -rx "manager reload" >/dev/null
else
  echo "→ Utilizador AMI 'callcenter' já existe — mantido"
fi

if ! grep -q '^\[callcenter-dialer\]' "$AST/extensions_custom.conf" 2>/dev/null; then
  echo "→ A acrescentar contexto [callcenter-dialer] (backup: extensions_custom.conf.$TS)"
  [ -f "$AST/extensions_custom.conf" ] && cp -p "$AST/extensions_custom.conf" "$AST/extensions_custom.conf.$TS"
  { echo; cat "$SRC/asterisk/extensions_custom.conf"; } >> "$AST/extensions_custom.conf"
  asterisk -rx "dialplan reload" >/dev/null
else
  echo "→ Contexto [callcenter-dialer] já existe — mantido"
fi
chown asterisk:asterisk "$AST/manager_custom.conf" "$AST/extensions_custom.conf" 2>/dev/null || true

chown -R asterisk:asterisk "$DEST"
cp "$SRC/callcenter-dialer.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable callcenter-dialer >/dev/null 2>&1
systemctl restart callcenter-dialer
sleep 2
systemctl --no-pager --lines=5 status callcenter-dialer || true

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "✔ Instalado. Painel: http://${IP:-IP-DA-CENTRAL}:8089"
echo "  Senha: ver \"senha\" em $DEST/config.json"
echo "  Se usa a Firewall do FreePBX, libertar a porta 8089 só para a rede do escritório."
