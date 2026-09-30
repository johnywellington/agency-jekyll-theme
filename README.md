# 📞 Call Center Dialer — FreePBX / Asterisk

Discador de call center para FreePBX 17 / Asterisk:

1. **Cola uma lista de números**
2. **Escolhe o tronco** e o ramal que atende
3. **Carrega em "Ligar"**
4. O sistema liga ao cliente. **Quando o cliente atende, toca no ramal** e o agente vê o número/nome do cliente no telefone.

O projeto reutiliza a ligação AMI do **Call Monitor** (parser, Ping, watchdog de reconexão, confirmação em dois cliques). Não tem dependências: só precisa do Node.js 18 ou mais recente.

---

## Funcionalidades

### Campanhas
- Várias campanhas ao mesmo tempo, cada uma com o seu tronco, destino e regras
- **Ligar / Pausar / Continuar / Parar e desligar**: parar desliga as chamadas que ainda estão a tocar no cliente e não corta as que já estão em conversa
- Adicionar números a uma campanha que já existe
- Editar a configuração a qualquer momento
- Apagar com confirmação em dois cliques
- A campanha fica **Concluída** quando todos os números foram tratados

### Lista de números
- Um número por linha, com ou sem nome: `912345678`, `912345678;Maria`, `Maria,+351912345678`
- Pode colar diretamente do **Excel** (colunas separadas por tab)
- Limpa espaços, pontos, traços e parênteses
- Remove **números repetidos** e indica quantos são inválidos
- Opções: acrescentar prefixo (ex. `00`), remover prefixo (ex. `351`), tirar o `+`

### Saída das chamadas
- **Escolha do tronco**: a lista vem do Asterisk (endpoints PJSIP que não são ramais)
- Em alternativa, **Rotas de saída do FreePBX**, que aplicam as regras de marcação das rotas
- **CallerID** que o cliente vê, configurável por campanha
- **Chamadas em simultâneo**, de 1 a 50
- **Tempo a tocar** no cliente (10 a 120 s)
- **Horário permitido**, ex. 09:00 a 20:00 (suporta janelas que passam a meia-noite). Fora do horário a campanha espera sozinha

### Quando o cliente atende
- Toca num **ramal, fila ou ring group** do FreePBX
- O agente vê o **número e o nome do cliente** no ecrã do telefone
- **Só liga quando o ramal está livre**: consulta o estado do ramal antes de cada chamada, para o cliente nunca atender sem ninguém do outro lado. Avisa quando o telefone não está registado

### Resultados e novas tentativas
- Estados em tempo real: **Pendente → A ligar → A tocar → Atendeu (a tocar no ramal) → Em conversa**
- Resultados finais: **Concluída** (com duração da conversa), **Não atendeu**, **Ocupado**, **Recusou**, **Sem agente** (o cliente atendeu mas desligou antes do agente), **Falhou**, **Blacklist**
- **Novas tentativas automáticas** para quem não atendeu, estava ocupado ou falhou, com número de tentativas e intervalo configuráveis
- Botão **"Voltar a ligar aos não concluídos"**
- **Blacklist do FreePBX**: os números bloqueados são saltados e nunca são ligados
- Histórico de cada número: passe o rato sobre o detalhe para ver as tentativas com a hora

### Painel
- Atualização ao vivo (SSE), sem recarregar a página
- Cartões de resumo que funcionam como filtro: clique em "Ocupado" para ver só esses
- Barra de progresso e cronómetro das chamadas em curso
- Ações por número: **📞 ligar já**, **desligar**, **remover**
- **Exportar CSV** com o resultado de cada número (abre no Excel)
- Funciona no telemóvel e segue o modo escuro do sistema

### Fiabilidade
- Reconexão automática à AMI e watchdog que deteta ligações mortas ao fim de 75 s
- Reconciliação a cada minuto com o Asterisk (`CoreShowChannels`): uma chamada nunca fica presa como "em curso"
- Dados gravados de forma atómica (`dados.json`). Um corte de energia não corrompe o ficheiro
- Se o serviço reiniciar a meio, as chamadas em curso voltam para a fila e as campanhas ficam em pausa
- Login com senha, cookie HttpOnly e bloqueio de 1 minuto após 5 tentativas erradas

---

## Como funciona

```
 Painel ──HTTP──► server.js ──AMI Originate──► Asterisk
                                  Channel:  PJSIP/<numero>@<tronco>
                                  Context:  callcenter-dialer, s
                                  Variable: CC_NUM, CC_NOME, CC_DEST
                                                │ cliente atende
                                                ▼
                               [callcenter-dialer] → CALLERID = cliente
                                                → Goto(from-internal, <ramal>)
                                                ▼
                                            toca no ramal
```

Estes eventos da AMI dão o estado de cada chamada:

| Evento | Estado |
|---|---|
| `Newstate` Ringing | a tocar no cliente |
| `OriginateResponse` Success | cliente atendeu, a tocar no ramal |
| `OriginateResponse` Failure, Reason 3 / 5 / 1 / 0 | não atendeu / ocupado / recusou / falhou |
| `BridgeEnter` | agente atendeu (em conversa) |
| `Hangup` | fim da chamada e cálculo da duração |

O `ChannelId` do Originate é definido pelo discador. Assim o Uniqueid é conhecido antes de a chamada existir, e não é preciso adivinhar qual é o canal.

---

## Instalação na central

```bash
# na central FreePBX, como root
git clone -b claude/freepbx-call-center-module-fzv1de https://github.com/johnywellington/agency-jekyll-theme callcenter-dialer
cd callcenter-dialer
bash install.sh
```

O `install.sh` faz o seguinte:
1. Copia o código para `/opt/callcenter-dialer`
2. Cria o `config.json` com uma **senha aleatória** para o painel e um segredo para a AMI
3. Acrescenta o utilizador AMI `callcenter` a `/etc/asterisk/manager_custom.conf`, com backup datado e acesso só a partir de 127.0.0.1
4. Acrescenta o contexto `[callcenter-dialer]` a `/etc/asterisk/extensions_custom.conf`, também com backup
5. Faz `manager reload` e `dialplan reload`, que não derrubam chamadas
6. Instala e arranca o serviço `callcenter-dialer` (systemd)

Painel: `http://IP-DA-CENTRAL:8089`. Se usa a Firewall do FreePBX, libertar a porta 8089 só para a rede do escritório.

> Em `callcenter-dialer.service`, ajustar `TZ=` ao fuso da operação. O horário permitido das campanhas usa essa hora.

### Instalação manual
- Copiar `asterisk/manager_custom.conf` e `asterisk/extensions_custom.conf` para os ficheiros com o mesmo nome em `/etc/asterisk/`, trocando o segredo
- Copiar `config.example.json` para `config.json` e preencher
- `node server.js`

Todas as opções do `config.json` também aceitam variáveis de ambiente: `CC_PORT`, `CC_SENHA`, `AMI_HOST`, `AMI_PORT`, `AMI_USER`, `AMI_PASS`, `CC_DADOS`, `CC_CONTEXTO`.

### Permissões AMI necessárias
```
read  = call,system,reporting
write = call,originate,system,reporting
```
As permissões são avaliadas no login. Depois de as alterar, reinicie o serviço.

---

## Testar sem central

```bash
npm test        # teste ponta-a-ponta com um Asterisk simulado
```

Para ver o painel a funcionar:

```bash
node test/mock-ami.js 15038 &
CC_SENHA=demo AMI_PORT=15038 AMI_PASS=x node server.js
# abrir http://localhost:8089  (senha: demo)
```

No simulador, o resultado depende do último dígito do número:

| Último dígito | Resultado |
|---|---|
| 1 | atende e o agente fala |
| 2 | ocupado |
| 3 | não atende |
| 4 | o cliente atende e desliga antes do agente |
| 5 | falha |

Números começados por `000` estão na blacklist.

---

## Notas
- No modo **tronco**, o número sai tal como está na lista (depois dos prefixos da campanha): não passa pelas regras das rotas de saída. Para usar as regras das rotas, escolha **Rotas de saída do FreePBX**.
- Sem o contexto `[callcenter-dialer]`, as chamadas funcionam na mesma, mas o agente vê o CallerID de saída em vez do número do cliente. O painel mostra um aviso quando isso acontece.
- Enquanto o ramal toca, o cliente ouve o que o FreePBX tocar ao ligar para esse ramal. Normalmente é o tom de chamada (depende das opções de Dial do FreePBX).
