#!/usr/bin/env bash
# Instala o Call Center Dialer.
# Correr como root dentro da pasta do projeto:   sudo bash install.sh
#
# Dois modos, escolhidos automaticamente:
#  • NA CENTRAL (há Asterisk nesta máquina): instala o painel E configura o Asterisk
#    (utilizador AMI + contexto [callcenter-dialer], com backup datado).
#  • NOUTRO SERVIDOR (sem Asterisk, ex. o servidor do Call Monitor): instala só o painel,
#    numa pasta própria, e liga à AMI por um túnel/porta. NÃO mexe na central —
#    no fim mostra o que é preciso acrescentar lá, para fazer à mão com autorização.
#
# Variáveis opcionais:  DEST=/opt/callcenter-dialer  CC_PORT=8089  AMI_HOST=127.0.0.1
#                       AMI_PORT=5038 (central) / 5039 (remoto)  TZ_OP=America/Sao_Paulo
# Idempotente: pode correr outra vez para atualizar o código (não mexe na config nem nos dados).
set -euo pipefail

DEST=${DEST:-/opt/callcenter-dialer}
AST=/etc/asterisk
SRC="$(cd "$(dirname "$0")" && pwd)"
TS=$(date +%Y%m%d-%H%M%S)
CC_PORT=${CC_PORT:-8089}
AMI_HOST=${AMI_HOST:-127.0.0.1}
TZ_OP=${TZ_OP:-America/Sao_Paulo}

[ "$(id -u)" = 0 ] || { echo "Correr como root."; exit 1; }
command -v node >/dev/null || { echo "Node.js não encontrado. Instalar Node 18+ (apt install nodejs)."; exit 1; }
NODEV=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODEV" -ge 18 ] || { echo "Node $NODEV é antigo — precisa de 18 ou mais recente."; exit 1; }

if command -v asterisk >/dev/null && [ -d "$AST" ]; then
  MODO=central; AMI_PORT=${AMI_PORT:-5038}
else
  MODO=remoto;  AMI_PORT=${AMI_PORT:-5039}
fi
echo "→ Modo: $MODO  ·  pasta $DEST  ·  painel na porta $CC_PORT  ·  AMI $AMI_HOST:$AMI_PORT"

# não pisar outro serviço que já use a porta (ex. Call Monitor na 8088)
if ! systemctl is-active --quiet callcenter-dialer 2>/dev/null && command -v ss >/dev/null && ss -ltn "( sport = :$CC_PORT )" | grep -q LISTEN; then
  echo "A porta $CC_PORT já está ocupada por outro serviço. Usar outra: CC_PORT=8090 bash install.sh"; exit 1
fi

echo "→ A copiar código para $DEST"
mkdir -p "$DEST/public"
cp "$SRC/server.js" "$SRC/ami.js" "$SRC/package.json" "$DEST/"
cp "$SRC/public/index.html" "$DEST/public/"

if [ ! -f "$DEST/config.json" ]; then
  SENHA=$(head -c 9 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
  AMISECRET=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  cat > "$DEST/config.json" <<EOF
{
  "porta": $CC_PORT,
  "host": "0.0.0.0",
  "senha": "$SENHA",
  "contexto": "callcenter-dialer",
  "dados": "$DEST/dados.json",
  "ami": { "host": "$AMI_HOST", "port": $AMI_PORT, "user": "callcenter", "pass": "$AMISECRET" }
}
EOF
  chmod 600 "$DEST/config.json"
  echo "→ config.json criado (senha do painel: $SENHA)"
else
  AMISECRET=$(node -p "require('$DEST/config.json').ami.pass")
  echo "→ config.json já existe — mantido"
fi

if [ "$MODO" = central ]; then
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
  RUNUSER=asterisk
else
  # servidor sem Asterisk: utilizador de sistema próprio, sem shell
  id callcenter >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin callcenter
  RUNUSER=callcenter
fi

chown -R "$RUNUSER:$RUNUSER" "$DEST"
sed -e "s#/opt/callcenter-dialer#$DEST#g" -e "s#^User=.*#User=$RUNUSER#" -e "s#^Group=.*#Group=$RUNUSER#" \
    -e "s#^Environment=TZ=.*#Environment=TZ=$TZ_OP#" "$SRC/callcenter-dialer.service" > /etc/systemd/system/callcenter-dialer.service
systemctl daemon-reload
systemctl enable callcenter-dialer >/dev/null 2>&1
systemctl restart callcenter-dialer
sleep 2
systemctl --no-pager --lines=5 status callcenter-dialer || true

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "✔ Painel instalado: http://${IP:-IP-DO-SERVIDOR}:$CC_PORT"
echo "  Senha: ver \"senha\" em $DEST/config.json"

if [ "$MODO" = remoto ]; then
  cat <<EOF

⚠️  A CENTRAL NÃO FOI ALTERADA. O painel vai mostrar "Asterisk desligado" até:

  1) A AMI da central estar acessível em $AMI_HOST:$AMI_PORT a partir deste servidor
     (ex. o túnel SSH que o Call Monitor já usa, ou um túnel novo).

  2) Na CENTRAL, com a sua autorização, acrescentar a /etc/asterisk/manager_custom.conf:
$(sed "s/TROCAR-SEGREDO-AMI/$AMISECRET/; s/^/       /" "$SRC/asterisk/manager_custom.conf")
     e correr:  asterisk -rx "manager reload"
     (o permit 127.0.0.1 serve para ligações que chegam pelo túnel SSH)

  3) Na CENTRAL, acrescentar a /etc/asterisk/extensions_custom.conf o conteúdo de
     asterisk/extensions_custom.conf e correr:  asterisk -rx "dialplan reload"
     (opcional — sem isto liga na mesma, mas o ramal não mostra o número do cliente)

  Depois:  systemctl restart callcenter-dialer
EOF
else
  echo "  Se usa a Firewall do FreePBX, libertar a porta $CC_PORT só para a rede do escritório."
fi
