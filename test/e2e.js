'use strict';
/* Teste ponta-a-ponta: arranca o AMI falso + o servidor, cria uma campanha com a API,
   carrega em "Ligar" e confirma o resultado de cada número e o que foi enviado ao Asterisk. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const criarMock = require('./mock-ami');

const esperar = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const mock = await criarMock();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccdialer-'));
  const porta = 18000 + Math.floor(Math.random() * 1000);
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, {
      CC_PORT: String(porta), CC_HOST: '127.0.0.1', CC_SENHA: 'teste', CC_DADOS: path.join(dir, 'dados.json'),
      CC_CONFIG: path.join(dir, 'nao-existe.json'), AMI_HOST: '127.0.0.1', AMI_PORT: String(mock.porta), AMI_USER: 'x', AMI_PASS: 'y'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  srv.stdout.on('data', d => { log += d; });
  srv.stderr.on('data', d => { log += d; });

  const base = `http://127.0.0.1:${porta}`;
  let cookie = '';
  const api = async (metodo, url, corpo) => {
    const r = await fetch(base + url, { method: metodo, headers: { 'Content-Type': 'application/json', cookie }, body: corpo && JSON.stringify(corpo) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null) };
  };

  try {
    for (let i = 0; i < 50 && !/AMI ligado/.test(log); i++) await esperar(100);
    assert.match(log, /AMI ligado/, 'o servidor devia ligar à AMI');

    assert.strictEqual((await api('GET', '/api/campanhas/1/csv')).status, 401, 'sem login devia dar 401');
    assert.strictEqual((await api('POST', '/api/login', { senha: 'errada' })).status, 401);
    assert.strictEqual((await api('POST', '/api/login', { senha: 'teste' })).status, 200);

    const tr = await api('POST', '/api/troncos');
    assert.deepStrictEqual(tr.body.troncos.map(t => t.nome), ['Narayana-01', 'Zadarma-Entrada'], 'ramais numéricos não são troncos');

    // tronco inexistente é recusado ao iniciar
    const mau = await api('POST', '/api/campanhas', { nome: 'x', tronco: 'NaoExiste', destino: '1001', numeros: '911111111' });
    assert.strictEqual((await api('POST', `/api/campanhas/${mau.body.campanha.id}/iniciar`)).status, 400);
    await api('DELETE', `/api/campanhas/${mau.body.campanha.id}`);

    const numeros = [
      '911 111 111;Ana',      // concluida
      'Bruno,+351912222222',  // ocupado
      '913333333',            // não atende
      '914444444',            // sem agente
      '915555555',            // falhou
      '000999991',            // blacklist
      '911111111',            // repetido
      'lixo'                  // inválido
    ].join('\n');
    const r = await api('POST', '/api/campanhas', {
      nome: 'Teste', tronco: 'Narayana-01', destino: '1001', simultaneas: 3, tentativas: 2, intervaloMin: 0,
      callerid: '351210000000', numeros, iniciar: true
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.adicionados, 6);
    assert.strictEqual(r.body.duplicados, 1);
    assert.strictEqual(r.body.invalidos.length, 1);
    const id = r.body.campanha.id;

    // acompanhar pelo SSE até concluir
    let camp = null;
    const ctrl = new AbortController();
    const sse = await fetch(base + '/api/eventos', { headers: { cookie }, signal: ctrl.signal });
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const limite = Date.now() + 20000;
    while (Date.now() < limite) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const m = JSON.parse(buf.slice(6, i)); buf = buf.slice(i + 2);
        if (m.tipo === 'campanha' && m.campanha.id === id) camp = m.campanha;
        if (m.tipo === 'inicio') camp = m.campanhas.find(c => c.id === id);
      }
      if (camp && camp.estado === 'concluida') break;
    }
    ctrl.abort();

    assert.ok(camp, 'devia receber a campanha pelo SSE');
    assert.strictEqual(camp.estado, 'concluida', 'campanha devia concluir; aviso: ' + camp.aviso);
    const por = Object.fromEntries(camp.contatos.map(k => [k.numero, k]));
    assert.strictEqual(por['911111111'].estado, 'concluida');
    assert.strictEqual(por['911111111'].nome, 'Ana');
    assert.ok(por['911111111'].duracaoSeg >= 1, 'duração da conversa');
    assert.strictEqual(por['+351912222222'].estado, 'ocupado');
    assert.strictEqual(por['+351912222222'].tentativas, 2, 'ocupado devia ser tentado 2 vezes');
    assert.strictEqual(por['913333333'].estado, 'nao atendeu');
    assert.strictEqual(por['914444444'].estado, 'sem agente');
    assert.strictEqual(por['915555555'].estado, 'falhou');
    assert.strictEqual(por['000999991'].estado, 'bloqueado');
    assert.strictEqual(por['000999991'].tentativas, 0, 'blacklist nunca é ligado');

    // o que foi pedido ao Asterisk
    const o = mock.originates.find(x => x.Channel === 'PJSIP/911111111@Narayana-01');
    assert.ok(o, 'Originate pelo tronco escolhido');
    assert.strictEqual(o.Context, 'callcenter-dialer');
    assert.strictEqual(o.Exten, 's');
    assert.ok(o.Variable.includes('CC_DEST=1001'));
    assert.ok(o.Variable.includes('CC_NUM=911111111'));
    assert.ok(o.Variable.includes('CC_NOME=Ana'));
    assert.strictEqual(o.CallerID, '"351210000000" <351210000000>');
    assert.strictEqual(o.Async, 'true');
    assert.ok(o.ChannelId, 'ChannelId definido');
    assert.ok(!mock.originates.some(x => /000999991/.test(x.Channel)));
    assert.strictEqual(mock.originates.length, 1 + 2 + 2 + 2 + 2, 'número de Originates (com repetições)');

    // repetir os não concluídos
    const rep = await api('POST', `/api/campanhas/${id}/repetir`);
    assert.strictEqual(rep.body.repostos, 4);

    // CSV
    const csv = await fetch(`${base}/api/campanhas/${id}/csv`, { headers: { cookie } }).then(x => x.text());
    assert.match(csv, /911111111/);

    console.log('✔ e2e OK — ' + mock.originates.length + ' Originates, todos os resultados corretos');
  } catch (e) {
    console.error('✘ ' + e.message + '\n--- log do servidor ---\n' + log);
    process.exitCode = 1;
  } finally {
    srv.kill();
    mock.fechar();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
