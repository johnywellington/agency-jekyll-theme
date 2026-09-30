'use strict';
/* AMI falso para testar/demonstrar o discador sem uma central real.
   O resultado de cada chamada depende do ÚLTIMO dígito do número:
     1 → cliente atende, agente atende, conversa 2s   (concluida)
     2 → ocupado
     3 → toca e ninguém atende
     4 → cliente atende mas desliga antes do agente   (sem agente)
     5 → tronco recusa (falhou)
     resto → como o 1
   Números começados por 000 estão na "blacklist".
   Uso isolado:  node test/mock-ami.js 5038  */
const net = require('net');

function criarMock({ porta = 0, rapido = 1 } = {}) {
  const originates = [];
  const vivos = new Set();
  const socks = new Set();
  const ms = t => Math.round(t * rapido);

  const server = net.createServer(sock => {
    socks.add(sock);
    sock.on('close', () => socks.delete(sock));
    sock.on('error', () => {});
    sock.write('Asterisk Call Manager/9.0.0\r\n');
    let buf = '';
    const send = obj => { if (!sock.destroyed) sock.write(Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'); };
    const evAll = obj => { for (const s of socks) if (!s.destroyed) s.write(Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n'); };

    sock.on('data', chunk => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\r\n\r\n')) !== -1) {
        const bloco = buf.slice(0, i); buf = buf.slice(i + 4);
        const m = { Variable: [] };
        for (const l of bloco.split('\r\n')) {
          const p = l.indexOf(': ');
          if (p < 0) continue;
          const k = l.slice(0, p), v = l.slice(p + 2);
          if (k === 'Variable') m.Variable.push(v); else m[k] = v;
        }
        const id = m.ActionID;
        switch (m.Action) {
          case 'Login': send({ Response: 'Success', ActionID: id, Message: 'Authentication accepted' }); break;
          case 'Ping': send({ Response: 'Success', ActionID: id, Ping: 'Pong' }); break;
          case 'ShowDialPlan':
            if (m.Context === 'callcenter-dialer') {
              send({ Response: 'Success', ActionID: id, EventList: 'start' });
              send({ Event: 'ListDialplan', ActionID: id, Context: 'callcenter-dialer', Extension: 's' });
              send({ Event: 'ShowDialPlanComplete', ActionID: id, EventList: 'Complete' });
            } else send({ Response: 'Error', ActionID: id, Message: 'Did not find context' });
            break;
          case 'PJSIPShowEndpoints':
            send({ Response: 'Success', ActionID: id, EventList: 'start' });
            for (const [n, st] of [['1001', 'Not in use'], ['1002', 'In use'], ['Narayana-01', 'Not in use'], ['Zadarma-Entrada', 'Not in use']]) {
              send({ Event: 'EndpointList', ActionID: id, ObjectName: n, DeviceState: st });
            }
            send({ Event: 'EndpointListComplete', ActionID: id, EventList: 'Complete' });
            break;
          case 'ExtensionState': send({ Response: 'Success', ActionID: id, Exten: m.Exten, Status: '0', StatusText: 'Idle' }); break;
          case 'DBGet':
            if (m.Family === 'blacklist' && /^\+?000/.test(m.Key)) {
              send({ Response: 'Success', ActionID: id, EventList: 'start', Message: 'Result will follow' });
              send({ Event: 'DBGetResponse', ActionID: id, Family: 'blacklist', Key: m.Key, Val: '1' });
              send({ Event: 'DBGetComplete', ActionID: id, EventList: 'Complete' });
            } else send({ Response: 'Error', ActionID: id, Message: 'Database entry not found' });
            break;
          case 'CoreShowChannels':
            send({ Response: 'Success', ActionID: id, EventList: 'start' });
            for (const u of vivos) send({ Event: 'CoreShowChannel', ActionID: id, Uniqueid: u });
            send({ Event: 'CoreShowChannelsComplete', ActionID: id, EventList: 'Complete' });
            break;
          case 'Hangup': send({ Response: 'Success', ActionID: id, Message: 'Channel Hungup' }); break;
          case 'Originate': {
            originates.push(m);
            send({ Response: 'Success', ActionID: id, Message: 'Originate successfully queued' });
            const uid = m.ChannelId;
            const canal = m.Channel.replace(/@.*/, '') + '-0000' + originates.length;
            const ultimo = (m.Channel.match(/(\d)@/) || [])[1];
            vivos.add(uid);
            setTimeout(() => evAll({ Event: 'Newchannel', Channel: canal, Uniqueid: uid, Linkedid: uid }), ms(30));
            if (ultimo === '5') {
              setTimeout(() => { vivos.delete(uid); evAll({ Event: 'Hangup', Channel: canal, Uniqueid: uid, Cause: '34' });
                evAll({ Event: 'OriginateResponse', ActionID: id, Response: 'Failure', Channel: m.Channel, Uniqueid: uid, Reason: '0' }); }, ms(100));
              break;
            }
            setTimeout(() => evAll({ Event: 'Newstate', Channel: canal, Uniqueid: uid, ChannelStateDesc: 'Ringing' }), ms(80));
            if (ultimo === '2' || ultimo === '3') {
              setTimeout(() => { vivos.delete(uid); evAll({ Event: 'Hangup', Channel: canal, Uniqueid: uid });
                evAll({ Event: 'OriginateResponse', ActionID: id, Response: 'Failure', Channel: m.Channel, Uniqueid: uid, Reason: ultimo === '2' ? '5' : '3' }); }, ms(300));
              break;
            }
            setTimeout(() => evAll({ Event: 'OriginateResponse', ActionID: id, Response: 'Success', Channel: canal, Uniqueid: uid, Reason: '4' }), ms(300));
            if (ultimo === '4') {
              setTimeout(() => { vivos.delete(uid); evAll({ Event: 'Hangup', Channel: canal, Uniqueid: uid }); }, ms(700));
              break;
            }
            setTimeout(() => evAll({ Event: 'BridgeEnter', Channel: canal, Uniqueid: uid, BridgeUniqueid: 'b' + uid }), ms(600));
            setTimeout(() => { vivos.delete(uid); evAll({ Event: 'Hangup', Channel: canal, Uniqueid: uid }); }, ms(2600));
            break;
          }
          default: send({ Response: 'Error', ActionID: id, Message: 'Invalid/unknown command' });
        }
      }
    });
  });
  return new Promise(res => server.listen(porta, '127.0.0.1', () => res({
    porta: server.address().port, originates, fechar: () => { for (const s of socks) s.destroy(); server.close(); }
  })));
}

module.exports = criarMock;

if (require.main === module) {
  criarMock({ porta: +(process.argv[2] || 5038), rapido: 3 }).then(m => console.log('AMI falso em 127.0.0.1:' + m.porta));
}
