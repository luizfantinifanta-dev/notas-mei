// Página "Notas MEI": lista as comissões "Assinado" sem nota e manda o robô
// preencher a emissão no Emissor Nacional.
//   local:  node server.js   →   http://localhost:47310
//   VPS:    https://n8n.hmodonto.online/notas-mei-ste/  (BASE_PATH, com login)
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { notasPendentes } = require('./lib/planilha');
const { Emissor } = require('./lib/emissor');

const PORTA = Number(process.env.PORTA || 47310);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');

const app = express();
const rotas = express.Router();
app.set('trust proxy', true);

// Login simples (usuário/senha do .env). Sem eles, só funciona no próprio PC.
function exigirLogin(req, res, next) {
  const usuario = process.env.PAGINA_USUARIO, senha = process.env.PAGINA_SENHA;
  if (!usuario || !senha) {
    if (HOST === '127.0.0.1') return next();
    return res.status(503).send('Login da página não configurado.');
  }
  const [tipo, valor] = String(req.headers.authorization || '').split(' ');
  const [u, s] = tipo === 'Basic' && valor ? Buffer.from(valor, 'base64').toString().split(/:(.*)/s) : [];
  const igual = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  if (igual(u, usuario) && igual(s, senha)) return next();
  res.set('WWW-Authenticate', 'Basic realm="Notas MEI", charset="UTF-8"').status(401).send('Login necessário.');
}

rotas.use(exigirLogin);
rotas.use(express.json());
rotas.use(express.static(path.join(__dirname, 'public')));
rotas.use('/telas', express.static(path.join(__dirname, 'state')));

// Um trabalho do robô por vez.
let trabalho = null;

rotas.get('/api/pendentes', async (req, res) => {
  try {
    res.json({ ok: true, ...(await notasPendentes()) });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

rotas.get('/api/trabalho', (req, res) => res.json({ ok: true, trabalho }));

// Testar preenchimento: o robô preenche cada nota e confere, SEM emitir.
rotas.post('/api/testar', async (req, res) => {
  if (trabalho && !trabalho.fim) return res.status(409).json({ ok: false, erro: 'O robô já está trabalhando. Espere terminar.' });
  const linhas = (req.body.linhas || []).map(Number);
  let notas;
  try {
    notas = (await notasPendentes()).pendentes.filter((n) => linhas.includes(n.linha) && !n.problemas.length);
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
        item.tela = 'telas/' + path.basename(r.tela) + '?t=' + Date.now();
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
    console.log(`[teste] ${trabalho.itens.map((i) => `linha ${i.linha}: ${i.situacao}`).join(', ')}`);
  }
});

// Sem a barra final os caminhos relativos da página quebram: redireciona.
if (BASE_PATH) {
  app.use((req, res, next) => (req.path === BASE_PATH ? res.redirect(301, BASE_PATH + '/' + (req.url.split('?')[1] ? '?' + req.url.split('?')[1] : '')) : next()));
}
app.use(BASE_PATH || '/', rotas);

app.listen(PORTA, HOST, () => console.log(`Notas MEI: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORTA}${BASE_PATH}/`));
