'use strict';
/* Call Center Dialer para FreePBX / Asterisk
   ───────────────────────────────────────────
   Coloca-se uma lista de números, escolhe-se o tronco e carrega-se em "Ligar".
   O discador liga para o CLIENTE primeiro, pelo tronco escolhido; quando o cliente
   atende, a chamada entra no dialplan e TOCA NO RAMAL (ou fila / ring group).

   Como funciona por baixo:
     AMI Originate  Channel: PJSIP/<numero>@<tronco>      (ou Local/<numero>@from-internal/n)
                    Context: callcenter-dialer  Exten: s  (põe o número do cliente no ecrã do
                                                           agente e salta para o destino)
                    ChannelId: <id nosso>                 (sabemos o Uniqueid antes de tocar)
     Eventos        Newchannel/Newstate → a tocar · OriginateResponse → atendeu / não atendeu /
                    ocupado · BridgeEnter → agente atendeu · Hangup → fim e duração.

   Sem dependências — só Node.js ≥ 18. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AMI = require('./ami');

/* ─────────────────────────── configuração ─────────────────────────── */
const CONFIG_FILE = process.env.CC_CONFIG || path.join(__dirname, 'config.json');
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {
  if (e.code !== 'ENOENT') { console.error('config.json inválido: ' + e.message); process.exit(1); }
}
const cfg = {
  porta: +(process.env.CC_PORT || fileCfg.porta || 8089),
  host: process.env.CC_HOST || fileCfg.host || '0.0.0.0',
  senha: process.env.CC_SENHA ?? fileCfg.senha ?? '',
  contexto: process.env.CC_CONTEXTO || fileCfg.contexto || 'callcenter-dialer',
  dados: process.env.CC_DADOS || fileCfg.dados || path.join(__dirname, 'dados.json'),
  ami: {
    host: process.env.AMI_HOST || fileCfg.ami?.host || '127.0.0.1',
    port: +(process.env.AMI_PORT || fileCfg.ami?.port || 5038),
    user: process.env.AMI_USER || fileCfg.ami?.user || 'callcenter',
    pass: process.env.AMI_PASS || fileCfg.ami?.pass || ''
  }
};
if (!cfg.senha) console.log('⚠️  Sem senha configurada — o painel fica aberto a quem chegar à porta ' + cfg.porta);

/* ─────────────────────────── estado persistente ─────────────────────────── */
let db = { seq: 0, campanhas: [] };
try { db = JSON.parse(fs.readFileSync(cfg.dados, 'utf8')); } catch (e) {}
let saveTimer = null;
function salvar() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(salvarJa, 500);
}
function salvarJa() {
  clearTimeout(saveTimer);
  // escrita atómica: um corte de energia a meio não deixa o ficheiro truncado
  const tmp = cfg.dados + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, cfg.dados);
  } catch (e) { console.error('Erro a gravar dados: ' + e.message); }
}
const novoId = () => String(++db.seq);

// estados de um contacto
const FINAIS_OK = new Set(['concluida']);
const REPETIVEIS = new Set(['nao atendeu', 'ocupado', 'falhou', 'recusou', 'sem agente']);
const EM_CURSO = new Set(['a ligar', 'a tocar', 'atendeu', 'em conversa']);

// um serviço que reiniciou a meio perdeu o rasto destas chamadas — voltam à fila
for (const c of db.campanhas) {
  for (const k of c.contatos) {
    if (EM_CURSO.has(k.estado)) {
      anotar(k, 'serviço reiniciado durante a chamada — resultado desconhecido');
      k.estado = k.estado === 'em conversa' ? 'concluida' : 'pendente';
    }
  }
  if (c.estado === 'a correr') c.estado = 'pausada';
}

function anotar(k, texto) {
  k.historico = k.historico || [];
  k.historico.push({ ts: Date.now(), texto });
  if (k.historico.length > 15) k.historico.shift();
}

/* ─────────────────────────── números ─────────────────────────── */
function limparNumero(raw, camp) {
  let n = String(raw || '').trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(n)) return null;
  if (camp.removerMais) n = n.replace(/^\+/, '');
  if (camp.removerPrefixo && n.startsWith(camp.removerPrefixo)) n = n.slice(camp.removerPrefixo.length);
  if (camp.prefixo) n = camp.prefixo + n;
  return n.length >= 3 && n.length <= 20 ? n : null;
}
/* Aceita um por linha: "912345678", "912345678;Maria", "Maria,912345678", colado do Excel (tab). */
function lerLista(texto, camp) {
  const vistos = new Set(camp.contatos.map(k => k.numero));
  const novos = [], invalidos = [];
  let duplicados = 0;
  for (const linha of String(texto || '').split(/\r?\n/)) {
    if (!linha.trim()) continue;
    const partes = linha.split(/[;,\t]/).map(s => s.trim()).filter(Boolean);
    let numRaw = partes.find(p => /^\+?[\d\s().-]{3,}$/.test(p));
    const nome = partes.filter(p => p !== numRaw).join(' ').slice(0, 60);
    const numero = numRaw ? limparNumero(numRaw, camp) : null;
    if (!numero) { invalidos.push(linha.trim().slice(0, 40)); continue; }
    if (vistos.has(numero)) { duplicados++; continue; }
    vistos.add(numero);
    novos.push({ id: novoId(), numero, nome, estado: 'pendente', tentativas: 0, proximaEm: 0, historico: [] });
  }
  return { novos, invalidos, duplicados };
}

/* ─────────────────────────── campanhas ─────────────────────────── */
const PADRAO = {
  nome: 'Campanha',
  modo: 'tronco',          // 'tronco' = sai pelo tronco escolhido · 'rotas' = rotas de saída do FreePBX
  tronco: '',
  destino: '',             // ramal, fila ou ring group que recebe a chamada atendida
  simultaneas: 1,          // chamadas em simultâneo
  toqueSeg: 30,            // quanto tempo deixa tocar no cliente
  tentativas: 3,           // total de tentativas por número
  intervaloMin: 30,        // espera antes de voltar a tentar
  callerid: '',            // número que o cliente vê (vazio = o do tronco)
  prefixo: '', removerPrefixo: '', removerMais: false,
  esperarRamalLivre: true, // só liga quando o ramal destino está livre
  verificarBlacklist: true,
  horaInicio: '', horaFim: '' // janela permitida, ex. "09:00"–"20:00"
};
function aplicarConfig(camp, body) {
  for (const k of Object.keys(PADRAO)) if (body[k] !== undefined) camp[k] = body[k];
  camp.nome = String(camp.nome || 'Campanha').slice(0, 60);
  camp.modo = camp.modo === 'rotas' ? 'rotas' : 'tronco';
  camp.tronco = String(camp.tronco || '').replace(/[^\w.@-]/g, '');
  camp.destino = String(camp.destino || '').replace(/[^\d*#]/g, '');
  camp.simultaneas = Math.min(50, Math.max(1, parseInt(camp.simultaneas, 10) || 1));
  camp.toqueSeg = Math.min(120, Math.max(10, parseInt(camp.toqueSeg, 10) || 30));
  camp.tentativas = Math.min(10, Math.max(1, parseInt(camp.tentativas, 10) || 1));
  camp.intervaloMin = Math.min(1440, Math.max(0, parseInt(camp.intervaloMin, 10) || 0));
  camp.callerid = String(camp.callerid || '').replace(/[^\d+]/g, '');
  camp.prefixo = String(camp.prefixo || '').replace(/[^\d+]/g, '');
  camp.removerPrefixo = String(camp.removerPrefixo || '').replace(/[^\d+]/g, '');
  camp.removerMais = !!camp.removerMais;
  camp.esperarRamalLivre = !!camp.esperarRamalLivre;
  camp.verificarBlacklist = !!camp.verificarBlacklist;
  camp.horaInicio = /^\d\d:\d\d$/.test(camp.horaInicio) ? camp.horaInicio : '';
  camp.horaFim = /^\d\d:\d\d$/.test(camp.horaFim) ? camp.horaFim : '';
}
function validarParaIniciar(camp) {
  if (!camp.destino) return 'falta o ramal / fila de destino';
  if (camp.modo === 'tronco' && !camp.tronco) return 'falta escolher o tronco';
  if (!camp.contatos.length) return 'a lista de números está vazia';
  return null;
}
function dentroDoHorario(camp) {
  if (!camp.horaInicio || !camp.horaFim) return true;
  const d = new Date();
  const agora = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return camp.horaInicio <= camp.horaFim
    ? agora >= camp.horaInicio && agora < camp.horaFim
    : agora >= camp.horaInicio || agora < camp.horaFim; // janela que passa a meia-noite
}
function resumo(camp) {
  const r = { total: camp.contatos.length };
  for (const k of camp.contatos) r[k.estado] = (r[k.estado] || 0) + 1;
  return r;
}
const getCamp = id => db.campanhas.find(c => c.id === id);

/* ─────────────────────────── AMI ─────────────────────────── */
const ami = new AMI(cfg.ami);
let temContexto = false;      // o contexto callcenter-dialer existe no dialplan?
let troncos = [];             // endpoints PJSIP que não são ramais
const emVoo = new Map();      // uid -> { campId, contatoId, desde }
const porAction = new Map();  // ActionID do Originate -> uid

ami.on('status', async ok => {
  console.log('AMI ' + (ok ? 'ligado' : 'desligado'));
  broadcast({ tipo: 'ami', ligado: ok });
  if (!ok) return;
  await verificarContexto();
  await carregarTroncos();
  reconciliar();
});
ami.on('error', e => console.log(e.message));

async function verificarContexto() {
  try {
    const r = await ami.action({ Action: 'ShowDialPlan', Context: cfg.contexto });
    temContexto = r.Response === 'Success';
  } catch (e) { temContexto = false; }
  if (!temContexto) console.log(`⚠️  Contexto [${cfg.contexto}] não existe no dialplan — o agente vai ver o CallerID de saída em vez do número do cliente. Ver asterisk/extensions_custom.conf.`);
  broadcast({ tipo: 'sistema', temContexto });
}
async function carregarTroncos() {
  try {
    const r = await ami.action({ Action: 'PJSIPShowEndpoints' }, { timeout: 15000 });
    // no FreePBX os ramais são numéricos; o resto são troncos
    troncos = (r.events || [])
      .filter(e => e.Event === 'EndpointList' && e.ObjectName && !/^\d+$/.test(e.ObjectName) && e.ObjectName !== 'dpma_endpoint')
      .map(e => ({ nome: e.ObjectName, estado: e.DeviceState || '' }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
    broadcast({ tipo: 'troncos', troncos });
  } catch (e) { console.log('Não foi possível listar troncos: ' + e.message); }
}

async function estadoRamal(ramal) {
  // FreePBX publica as hints dos ramais em ext-local
  try {
    const r = await ami.action({ Action: 'ExtensionState', Exten: ramal, Context: 'ext-local' });
    return r.Response === 'Success' ? parseInt(r.Status, 10) : -1;
  } catch (e) { return -1; }
}
async function naBlacklist(numero) {
  const variantes = new Set([numero, numero.replace(/^\+/, ''), '+' + numero.replace(/^\+/, '')]);
  for (const v of variantes) {
    try {
      const r = await ami.action({ Action: 'DBGet', Family: 'blacklist', Key: v }, { expectEvent: 'DBGetResponse' });
      if (r.Response === 'Success' && r.Event === 'DBGetResponse') return true;
    } catch (e) {}
  }
  return false;
}

async function ligar(camp, k) {
  const uid = 'cc' + Date.now() + '.' + k.id;
  k.estado = 'a ligar';
  k.tentativas++;
  k.ultimaEm = Date.now();
  k.uid = uid;
  k.canal = null;
  k.atendeuEm = k.conversaEm = null;
  emVoo.set(uid, { campId: camp.id, contatoId: k.id, desde: Date.now() });
  anotar(k, `tentativa ${k.tentativas}/${camp.tentativas}`);
  mudou(camp);

  const canal = camp.modo === 'rotas'
    ? `Local/${k.numero}@from-internal/n`   // /n: sem otimização, o Uniqueid mantém-se até ao fim
    : `PJSIP/${k.numero}@${camp.tronco}`;
  const nome = (k.nome || k.numero).replace(/[^\p{L}\p{N} ._-]/gu, '');
  const acao = {
    Action: 'Originate',
    Channel: canal,
    ChannelId: uid,
    Timeout: String(camp.toqueSeg * 1000),
    Account: 'CC' + camp.id,
    Async: 'true',
    Variable: [`CC_NUM=${k.numero}`, `CC_NOME=${nome}`, `CC_DEST=${camp.destino}`, `CC_CAMP=${camp.id}`]
  };
  if (camp.modo === 'rotas') acao.OtherChannelId = uid + '-2';
  if (temContexto) Object.assign(acao, { Context: cfg.contexto, Exten: 's', Priority: '1' });
  else Object.assign(acao, { Context: 'from-internal', Exten: camp.destino, Priority: '1' });
  if (camp.callerid) acao.CallerID = `"${camp.callerid}" <${camp.callerid}>`;

  try {
    const actionId = 'orig-' + uid;
    porAction.set(actionId, uid);
    const r = await ami.action(Object.assign(acao, { ActionID: actionId }));
    if (r.Response !== 'Success') {
      porAction.delete(actionId);
      terminar(uid, 'falhou', 'o Asterisk recusou: ' + (r.Message || 'sem motivo'));
    }
  } catch (e) {
    terminar(uid, 'falhou', 'erro ao lançar: ' + e.message);
  }
}

/* Fecha a tentativa: decide se volta a tentar ou se o contacto fica arrumado. */
function terminar(uid, estado, texto) {
  const v = emVoo.get(uid);
  if (!v) return;
  emVoo.delete(uid);
  const camp = getCamp(v.campId);
  const k = camp && camp.contatos.find(x => x.id === v.contatoId);
  if (!k) return;
  k.resultado = estado;
  anotar(k, texto || estado);
  if (REPETIVEIS.has(estado) && k.tentativas < camp.tentativas) {
    k.estado = 'pendente';
    k.proximaEm = Date.now() + camp.intervaloMin * 60000;
    k.ultimoResultado = estado;
  } else {
    k.estado = estado;
    k.proximaEm = 0;
  }
  mudou(camp);
}

const MOTIVO = { 0: ['falhou', 'canal indisponível / tronco recusou'], 1: ['recusou', 'o cliente rejeitou'],
  3: ['nao atendeu', 'tocou e ninguém atendeu'], 5: ['ocupado', 'ocupado'], 8: ['falhou', 'rede congestionada'] };

ami.on('event', ev => {
  const uid = ev.Uniqueid;
  switch (ev.Event) {
    case 'Newchannel': {
      const v = emVoo.get(uid);
      if (!v) return;
      const k = contato(v);
      if (k) { k.canal = ev.Channel; mudou(getCamp(v.campId)); }
      break;
    }
    case 'Newstate': {
      const v = emVoo.get(uid);
      if (!v || ev.ChannelStateDesc !== 'Ringing') return;
      const k = contato(v);
      if (k && k.estado === 'a ligar') { k.estado = 'a tocar'; mudou(getCamp(v.campId)); }
      break;
    }
    case 'OriginateResponse': {
      const id = porAction.get(ev.ActionID) || (emVoo.has(uid) ? uid : null);
      if (!id) return;
      porAction.delete(ev.ActionID);
      const v = emVoo.get(id);
      if (!v) return;
      const k = contato(v);
      if (ev.Response === 'Success') {
        if (k) {
          k.estado = 'atendeu';
          k.atendeuEm = Date.now();
          if (ev.Channel) k.canal = ev.Channel;
          anotar(k, 'cliente atendeu — a tocar no ' + getCamp(v.campId).destino);
          mudou(getCamp(v.campId));
        }
      } else {
        const [estado, texto] = MOTIVO[ev.Reason] || ['falhou', 'falhou (motivo ' + ev.Reason + ')'];
        terminar(id, estado, texto);
      }
      break;
    }
    case 'BridgeEnter': {
      const v = emVoo.get(uid);
      if (!v) return;
      const k = contato(v);
      if (k && !k.conversaEm) {
        k.estado = 'em conversa';
        k.conversaEm = Date.now();
        anotar(k, 'agente atendeu');
        mudou(getCamp(v.campId));
      }
      break;
    }
    case 'Hangup': {
      const v = emVoo.get(uid);
      if (!v) return;
      const k = contato(v);
      if (!k) return terminar(uid, 'falhou');
      if (k.conversaEm) {
        k.duracaoSeg = Math.round((Date.now() - k.conversaEm) / 1000);
        terminar(uid, 'concluida', `conversa de ${k.duracaoSeg}s`);
      } else if (k.atendeuEm) {
        terminar(uid, 'sem agente', 'cliente atendeu mas desligou antes de o agente atender');
      }
      // sem atendimento: quem fecha é o OriginateResponse (traz o motivo certo)
      break;
    }
  }
});
function contato(v) {
  const camp = getCamp(v.campId);
  return camp && camp.contatos.find(x => x.id === v.contatoId);
}

/* A cada minuto: confirmar no Asterisk que as chamadas que julgamos vivas existem mesmo.
   Protege contra um Hangup perdido (ex.: AMI caiu no momento errado). */
async function reconciliar() {
  if (!ami.connected || !emVoo.size) return;
  let r;
  try { r = await ami.action({ Action: 'CoreShowChannels' }, { timeout: 15000 }); } catch (e) { return; }
  const vivos = new Set((r.events || []).map(e => e.Uniqueid));
  const agora = Date.now();
  for (const [uid, v] of emVoo) {
    if (vivos.has(uid) || agora - v.desde < 20000) continue;
    const k = contato(v);
    if (!k) { emVoo.delete(uid); continue; }
    if (k.conversaEm) { k.duracaoSeg = Math.round((agora - k.conversaEm) / 1000); terminar(uid, 'concluida', 'chamada terminou (reconciliação)'); }
    else if (k.atendeuEm) terminar(uid, 'sem agente', 'chamada terminou sem agente (reconciliação)');
    else if (agora - v.desde > (getCamp(v.campId)?.toqueSeg || 60) * 1000 + 30000) terminar(uid, 'falhou', 'sem resposta do Asterisk');
  }
}
setInterval(reconciliar, 60000);

/* ─────────────────────────── motor ─────────────────────────── */
const ocupado = new Set(); // campanhas com um passo do motor em curso (as verificações AMI são assíncronas)
async function passo(camp) {
  if (camp.estado !== 'a correr' || ocupado.has(camp.id) || !ami.connected) return;
  ocupado.add(camp.id);
  try {
    if (!dentroDoHorario(camp)) return aviso(camp, `fora do horário (${camp.horaInicio}–${camp.horaFim}) — à espera`);
    const agora = Date.now();
    const ativos = camp.contatos.filter(k => EM_CURSO.has(k.estado)).length;
    const proximo = camp.contatos.find(k => k.estado === 'pendente' && k.proximaEm <= agora);
    if (!proximo) {
      const futuro = camp.contatos.some(k => k.estado === 'pendente');
      if (!ativos && !futuro) {
        camp.estado = 'concluida';
        camp.aviso = 'todos os números foram tratados';
        mudou(camp);
      } else if (!ativos) aviso(camp, 'à espera das próximas tentativas');
      return;
    }
    if (ativos >= camp.simultaneas) return aviso(camp, '');
    if (camp.esperarRamalLivre && /^\d+$/.test(camp.destino)) {
      const st = await estadoRamal(camp.destino);
      // 0 livre · -1 sem hint (fila/ring group) · 4 indisponível · resto = ocupado/a tocar
      if (st === 4) return aviso(camp, `ramal ${camp.destino} indisponível (telefone não registado)`);
      if (st > 0) return aviso(camp, `à espera que o ramal ${camp.destino} fique livre`);
    }
    if (camp.estado !== 'a correr') return; // pausada enquanto esperávamos pela AMI
    if (camp.verificarBlacklist && await naBlacklist(proximo.numero)) {
      proximo.estado = 'bloqueado';
      anotar(proximo, 'número na blacklist do FreePBX — não foi ligado');
      return mudou(camp);
    }
    aviso(camp, '');
    await ligar(camp, proximo);
  } finally {
    ocupado.delete(camp.id);
  }
}
function aviso(camp, texto) {
  if (camp.aviso !== texto) { camp.aviso = texto; mudou(camp); }
}
// um Originate por campanha por segundo, no máximo — não afoga o tronco nem a AMI
setInterval(() => { for (const c of db.campanhas) passo(c).catch(e => console.log('motor: ' + e.message)); }, 1000);

/* ─────────────────────────── tempo real (SSE) ─────────────────────────── */
const clientes = new Set();
function broadcast(obj) {
  const data = 'data: ' + JSON.stringify(obj) + '\n\n';
  for (const res of clientes) res.write(data);
}
const sujas = new Set();
let flushTimer = null;
function mudou(camp) {
  if (!camp) return;
  salvar();
  sujas.add(camp.id);
  if (!flushTimer) flushTimer = setTimeout(() => {
    flushTimer = null;
    for (const id of sujas) { const c = getCamp(id); if (c) broadcast({ tipo: 'campanha', campanha: c }); }
    sujas.clear();
  }, 250);
}
setInterval(() => broadcast({ tipo: 'ping' }), 25000);

/* ─────────────────────────── HTTP ─────────────────────────── */
const sessoes = new Map(); // token -> expira
function autenticado(req) {
  if (!cfg.senha) return true;
  const m = /(?:^|;\s*)cctoken=([a-f0-9]{48})/.exec(req.headers.cookie || '');
  const exp = m && sessoes.get(m[1]);
  return !!exp && exp > Date.now();
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 5e6) { reject(new Error('pedido demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(new Error('JSON inválido')); } });
  });
}
const tentativasLogin = new Map();

const PAGINA = path.join(__dirname, 'public', 'index.html');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(PAGINA).pipe(res);
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const t = tentativasLogin.get(ip) || { n: 0, ate: 0 };
      if (t.ate > Date.now()) return json(res, 429, { erro: 'demasiadas tentativas — espera um minuto' });
      const body = await lerCorpo(req);
      const a = Buffer.from(String(body.senha || '')), b = Buffer.from(cfg.senha);
      if (!cfg.senha || (a.length === b.length && crypto.timingSafeEqual(a, b))) {
        tentativasLogin.delete(ip);
        const tk = crypto.randomBytes(24).toString('hex');
        sessoes.set(tk, Date.now() + 12 * 3600e3);
        res.setHeader('Set-Cookie', `cctoken=${tk}; HttpOnly; SameSite=Strict; Max-Age=43200; Path=/`);
        return json(res, 200, { ok: true });
      }
      t.n++; if (t.n >= 5) { t.ate = Date.now() + 60000; t.n = 0; }
      tentativasLogin.set(ip, t);
      return json(res, 401, { erro: 'senha errada' });
    }
    if (!p.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    if (!autenticado(req)) return json(res, 401, { erro: 'sessão expirada' });

    if (p === '/api/eventos') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({ tipo: 'inicio', ami: ami.connected, temContexto, troncos, campanhas: db.campanhas }) + '\n\n');
      clientes.add(res);
      req.on('close', () => clientes.delete(res));
      return;
    }
    if (p === '/api/troncos' && req.method === 'POST') { await carregarTroncos(); return json(res, 200, { troncos }); }

    if (p === '/api/campanhas' && req.method === 'POST') {
      const body = await lerCorpo(req);
      const camp = Object.assign({ id: novoId(), criadaEm: Date.now(), estado: 'parada', aviso: '', contatos: [] }, PADRAO);
      aplicarConfig(camp, body);
      const r = lerLista(body.numeros, camp);
      camp.contatos.push(...r.novos);
      db.campanhas.unshift(camp);
      mudou(camp);
      if (body.iniciar) {
        const erro = validarParaIniciar(camp);
        if (!erro) camp.estado = 'a correr';
        else camp.aviso = erro;
      }
      return json(res, 200, { campanha: camp, adicionados: r.novos.length, invalidos: r.invalidos, duplicados: r.duplicados });
    }

    const m = /^\/api\/campanhas\/(\d+)(?:\/([a-z]+))?(?:\/(\d+)\/([a-z]+))?$/.exec(p);
    if (m) {
      const camp = getCamp(m[1]);
      if (!camp) return json(res, 404, { erro: 'campanha não existe' });
      const acao = m[2];

      if (!acao && req.method === 'PUT') {
        aplicarConfig(camp, await lerCorpo(req));
        mudou(camp);
        return json(res, 200, { campanha: camp });
      }
      if (!acao && req.method === 'DELETE') {
        if (camp.contatos.some(k => EM_CURSO.has(k.estado))) return json(res, 409, { erro: 'há chamadas em curso — pára a campanha primeiro' });
        db.campanhas = db.campanhas.filter(c => c !== camp);
        salvar();
        broadcast({ tipo: 'apagada', id: camp.id });
        return json(res, 200, { ok: true });
      }
      if (acao === 'numeros' && req.method === 'POST') {
        const r = lerLista((await lerCorpo(req)).numeros, camp);
        camp.contatos.push(...r.novos);
        if (r.novos.length && camp.estado === 'concluida') camp.estado = 'pausada';
        mudou(camp);
        return json(res, 200, { adicionados: r.novos.length, invalidos: r.invalidos, duplicados: r.duplicados });
      }
      if (acao === 'iniciar' && req.method === 'POST') {
        const erro = validarParaIniciar(camp);
        if (erro) return json(res, 400, { erro });
        if (camp.modo === 'tronco' && troncos.length && !troncos.some(t => t.nome === camp.tronco)) {
          return json(res, 400, { erro: `o tronco "${camp.tronco}" não existe no Asterisk` });
        }
        camp.estado = 'a correr';
        camp.aviso = '';
        mudou(camp);
        return json(res, 200, { ok: true });
      }
      if (acao === 'pausar' && req.method === 'POST') {
        camp.estado = 'pausada';
        camp.aviso = 'pausada — as chamadas em curso terminam normalmente';
        mudou(camp);
        return json(res, 200, { ok: true });
      }
      if (acao === 'parar' && req.method === 'POST') {
        // pára e desliga as que ainda estão a tocar no cliente (as já atendidas não se cortam)
        camp.estado = 'pausada';
        camp.aviso = 'parada';
        let n = 0;
        for (const k of camp.contatos) {
          if ((k.estado === 'a ligar' || k.estado === 'a tocar') && k.canal) {
            ami.action({ Action: 'Hangup', Channel: k.canal }).catch(() => {});
            n++;
          }
        }
        mudou(camp);
        return json(res, 200, { ok: true, desligadas: n });
      }
      if (acao === 'repetir' && req.method === 'POST') {
        // volta a pôr na fila os que não foram concluídos (não atendeu, ocupado, falhou, sem agente)
        let n = 0;
        for (const k of camp.contatos) {
          if (REPETIVEIS.has(k.estado)) { k.estado = 'pendente'; k.tentativas = 0; k.proximaEm = 0; anotar(k, 'reposto na fila'); n++; }
        }
        if (n && camp.estado === 'concluida') camp.estado = 'pausada';
        mudou(camp);
        return json(res, 200, { repostos: n });
      }
      if (acao === 'csv' && req.method === 'GET') {
        const esc = s => '"' + String(s ?? '').replace(/"/g, '""') + '"';
        const linhas = [['numero', 'nome', 'estado', 'tentativas', 'ultimo_resultado', 'duracao_seg', 'ultima_tentativa'].join(';')];
        for (const k of camp.contatos) {
          linhas.push([k.numero, k.nome, k.estado, k.tentativas, k.ultimoResultado || k.resultado || '', k.duracaoSeg || '',
            k.ultimaEm ? new Date(k.ultimaEm).toLocaleString('pt-PT') : ''].map(esc).join(';'));
        }
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="campanha-${camp.id}.csv"`
        });
        return res.end('\ufeff' + linhas.join('\r\n'));
      }
      if (acao === 'contatos' && m[3]) {
        const k = camp.contatos.find(x => x.id === m[3]);
        if (!k) return json(res, 404, { erro: 'contacto não existe' });
        if (m[4] === 'ligar' && req.method === 'POST') {
          if (EM_CURSO.has(k.estado)) return json(res, 409, { erro: 'já está em chamada' });
          const erro = validarParaIniciar(camp);
          if (erro) return json(res, 400, { erro });
          if (!ami.connected) return json(res, 503, { erro: 'AMI desligada' });
          if (k.tentativas >= camp.tentativas) k.tentativas = camp.tentativas - 1; // ligação manual não conta para o limite
          await ligar(camp, k);
          return json(res, 200, { ok: true });
        }
        if (m[4] === 'desligar' && req.method === 'POST') {
          if (!k.canal) return json(res, 409, { erro: 'sem canal ativo' });
          const r = await ami.action({ Action: 'Hangup', Channel: k.canal });
          return json(res, 200, { ok: r.Response === 'Success', mensagem: r.Message });
        }
        if (m[4] === 'remover' && req.method === 'POST') {
          if (EM_CURSO.has(k.estado)) return json(res, 409, { erro: 'está em chamada' });
          camp.contatos = camp.contatos.filter(x => x !== k);
          mudou(camp);
          return json(res, 200, { ok: true });
        }
      }
    }
    json(res, 404, { erro: 'não encontrado' });
  } catch (e) {
    json(res, 500, { erro: e.message });
  }
});

server.listen(cfg.porta, cfg.host, () => {
  console.log(`Call Center Dialer em http://${cfg.host}:${cfg.porta}  ·  AMI ${cfg.ami.host}:${cfg.ami.port}`);
  ami.start();
});

function encerrar() { salvarJa(); process.exit(0); }
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
