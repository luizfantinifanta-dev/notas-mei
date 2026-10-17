// Página local "Notas MEI": lista as comissões "Assinado" sem nota e manda o
// robô preencher a emissão no Emissor Nacional. Só neste computador.
//   node server.js   →   http://localhost:47310
const path = require('path');
const express = require('express');
const { notasPendentes } = require('./lib/planilha');
const { Emissor } = require('./lib/emissor');

const PORTA = Number(process.env.PORTA || 47310);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/telas', express.static(path.join(__dirname, 'state')));

// Um trabalho do robô por vez.
let trabalho = null;

app.get('/api/pendentes', async (req, res) => {
  try {
    res.json({ ok: true, ...(await notasPendentes()) });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.get('/api/trabalho', (req, res) => res.json({ ok: true, trabalho }));

// Testar preenchimento: o robô preenche cada nota e confere, SEM emitir.
app.post('/api/testar', async (req, res) => {
  if (trabalho && !trabalho.fim) return res.status(409).json({ ok: false, erro: 'O robô já está trabalhando. Espere terminar.' });
  const linhas = (req.body.linhas || []).map(Number);
  let notas;
  try {
    notas = (await notasPendentes()).pendentes.filter((n) => linhas.includes(n.linha));
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message });
  }
  if (!notas.length) return res.status(400).json({ ok: false, erro: 'Nenhuma nota selecionada.' });
  trabalho = { tipo: 'teste', inicio: new Date().toISOString(), fim: null, etapa: 'entrando no Emissor Nacional…', itens: notas.map((n) => ({ linha: n.linha, situacao: 'aguardando' })) };
  res.json({ ok: true });

  const emissor = new Emissor();
  try {
    await emissor.abrir();
    for (const n of notas) {
      const item = trabalho.itens.find((i) => i.linha === n.linha);
      item.situacao = 'preenchendo';
      trabalho.etapa = `preenchendo linha ${n.linha} (${n.contrato})…`;
      try {
        const r = await emissor.preencher(n);
        item.situacao = r.diferencas.length ? 'diferente' : 'conferida';
        item.diferencas = r.diferencas;
        item.tela = '/telas/' + path.basename(r.tela) + '?t=' + Date.now();
      } catch (e) {
        item.situacao = 'erro';
        item.erro = e.message.split('\n')[0];
      }
    }
    trabalho.etapa = 'pronto — nada foi emitido (modo teste)';
    if (emissor.bloqueados.length) trabalho.etapa += ` · ${emissor.bloqueados.length} envio(s) ao site bloqueado(s)`;
  } catch (e) {
    trabalho.etapa = 'erro: ' + e.message.split('\n')[0];
  } finally {
    await emissor.fechar();
    trabalho.fim = new Date().toISOString();
  }
});

app.listen(PORTA, '127.0.0.1', () => console.log(`Notas MEI: http://localhost:${PORTA}`));
