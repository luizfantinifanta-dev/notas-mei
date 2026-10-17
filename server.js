// Página "Notas MEI": lista as comissões "Assinado" sem nota e manda o robô
// preencher a emissão no Emissor Nacional.
//   local:  node server.js   →   http://localhost:47310
//   VPS:    https://n8n.hmodonto.online/notas-mei-ste/  (BASE_PATH, com login)
require('dotenv').config({ path: require('path').join(__dirname, '.env'), quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const { notasPendentes, gravarEmissao, trocarLinkNota } = require('./lib/planilha');
const { Emissor } = require('./lib/emissor');
const { salvarNoDriveDela, apagarNoDriveDela } = require('./lib/google');
const registro = require('./lib/registro');

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
        item.avisos = r.avisos;
        item.nomeNoSite = r.lido.nome;
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

// EMITIR DE VERDADE as notas escolhidas (uma de cada vez). Cada uma: confere
// duplicidade, preenche, confere, emite, salva o comprovante no Drive dela e
// grava o nº (clicável) e a data na planilha. Erro numa → segue para a próxima;
// erro "incerto" (não sabe se emitiu) → PARA tudo.
const nomeArquivo = (n, numero) => `NFS-e ${numero} - ${n.empresa} - R$ ${n.comissao.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} - ${n.contrato}`.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 150);

rotas.post('/api/emitir', async (req, res) => {
  if (trabalho && !trabalho.fim) return res.status(409).json({ ok: false, erro: 'O robô já está trabalhando. Espere terminar.' });
  if (req.body.confirmado !== true) return res.status(400).json({ ok: false, erro: 'Falta confirmar a emissão.' });
  const linhas = (req.body.linhas || []).map(Number);
  let notas;
  try {
    notas = (await notasPendentes()).pendentes.filter((n) => linhas.includes(n.linha) && !n.problemas.length);
  } catch (e) {
    return res.status(500).json({ ok: false, erro: e.message });
  }
  if (!notas.length) return res.status(400).json({ ok: false, erro: 'Nenhuma nota selecionada.' });
  trabalho = { tipo: 'emissao', inicio: new Date().toISOString(), fim: null, etapa: 'entrando no Emissor Nacional…', itens: notas.map((n) => ({ linha: n.linha, situacao: 'aguardando' })) };
  res.json({ ok: true });
  console.log(`[emissão] ${notas.length} nota(s): linhas ${notas.map((n) => n.linha).join(', ')}`);

  const emissor = new Emissor();
  try {
    await emissor.abrir();
    for (const n of notas) {
      const item = trabalho.itens.find((i) => i.linha === n.linha);
      if (trabalho.parar) { item.situacao = 'nao-emitida'; item.erro = 'não tentada (a emissão anterior ficou incerta)'; continue; }
      trabalho.etapa = `emitindo linha ${n.linha} (${n.contrato})…`;
      const anterior = registro.jaEmitida(n);
      if (anterior) { item.situacao = 'erro'; item.erro = `já emitida por esta página (NFS-e ${anterior.numero}) — a planilha não foi atualizada; ponha o nº na linha`; continue; }
      item.situacao = 'emitindo';
      let emitida;
      try {
        emitida = await emissor.emitir(n, { chavesConhecidas: registro.chaves() });
      } catch (e) {
        item.situacao = e.incerta ? 'incerta' : 'erro';
        item.erro = e.message.split('\n')[0];
        if (e.incerta) trabalho.parar = true;
        console.log(`[emissão] linha ${n.linha}: ${item.situacao} — ${item.erro}`);
        continue;
      }
      // Emitida: registra JÁ (antes de qualquer outra coisa poder falhar).
      const numero = String(Number(emitida.chave.slice(23, 36)));
      registro.adicionar({ linha: n.linha, contrato: n.contrato, empresa: n.empresa, comissao: n.comissao, numero, chave: emitida.chave });
      Object.assign(item, { situacao: 'emitida', numero, chave: emitida.chave, avisos: emitida.avisos });
      console.log(`[emissão] linha ${n.linha}: NFS-e ${numero}`);
      const pendencias = [];
      try {
        trabalho.etapa = `NFS-e ${numero}: salvando o comprovante…`;
        const c = await emissor.comprovante(emitida.chave, `NFSe-${numero}-linha-${n.linha}`);
        item.comprovante = 'telas/notas/' + path.basename(c.pdf);
        const d = await salvarNoDriveDela(c.pdf, nomeArquivo(n, numero) + '.pdf');
        item.drive = d.link;
        registro.atualizar(emitida.chave, { drive: d.link, driveId: d.id });
      } catch (e) {
        pendencias.push('comprovante/Drive: ' + e.message.split('\n')[0]);
      }
      try {
        trabalho.etapa = `NFS-e ${numero}: gravando na planilha…`;
        const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
        await gravarEmissao(n, { numero, dataIso: hoje, link: item.drive });
        registro.atualizar(emitida.chave, { planilha: 'gravada' });
      } catch (e) {
        pendencias.push('planilha: ' + e.message.split('\n')[0]);
      }
      if (pendencias.length) { item.pendencias = pendencias; console.log(`[emissão] NFS-e ${numero}: ${pendencias.join(' | ')}`); }
    }
    const ok = trabalho.itens.filter((i) => i.situacao === 'emitida').length;
    trabalho.etapa = `pronto — ${ok} de ${notas.length} nota(s) emitida(s)` + (trabalho.parar ? ' · PAROU: uma emissão ficou incerta, confira no site' : '');
  } catch (e) {
    trabalho.etapa = 'erro: ' + e.message.split('\n')[0];
  } finally {
    await emissor.fechar();
    trabalho.fim = new Date().toISOString();
  }
});

// ---- Nota oficial (DANFSe) -------------------------------------------------
// O download do DANFSe no Emissor Nacional pede verificação humana: ela baixa
// no navegador dela e anexa aqui. A página reconhece a nota pela chave de
// acesso dentro do PDF, salva no Drive, troca o link do nº na planilha e
// apaga o comprovante (cópia da tela de consulta).
const idDoLink = (link) => (/\/d\/([\w-]+)/.exec(link || '') || [])[1];

rotas.get('/api/emitidas', (req, res) => {
  const lista = registro.ler().map((x) => ({
    numero: x.numero, chave: x.chave, linha: x.linha, contrato: x.contrato, empresa: x.empresa, comissao: x.comissao,
    em: x.em, drive: x.drive, oficial: x.oficial || null,
  }));
  res.json({ ok: true, emitidas: lista.reverse() });
});

let anexando = Promise.resolve();
rotas.post('/api/oficial', express.raw({ type: () => true, limit: '15mb' }), (req, res) => {
  // Um anexo de cada vez (registro e planilha sem disputa).
  anexando = anexando.then(() => anexarOficial(req, res)).catch(() => {});
});

async function anexarOficial(req, res) {
  const nomeOriginal = decodeURIComponent(String(req.headers['x-nome'] || 'arquivo.pdf'));
  try {
    const corpo = req.body;
    if (!Buffer.isBuffer(corpo) || corpo.slice(0, 5).toString() !== '%PDF-') throw new Error('não é um arquivo PDF.');
    let texto = '';
    try { texto = (await pdfParse(corpo)).text || ''; } catch (e) { /* PDF sem texto legível */ }
    // O comprovante provisório (cópia da tela de consulta) também tem a chave:
    // não pode passar por nota oficial.
    if (/Portal de Gest[ãa]o NFS-e/i.test(texto) && /Visualiza[çc][ãa]o/i.test(texto)) throw new Error('este é o comprovante provisório (cópia da tela), não a nota oficial. Baixe pelo botão "Baixar nota oficial".');
    const digitos = texto.replace(/\D/g, '') + ' ' + nomeOriginal.replace(/\D/g, '');
    const nota = registro.ler().find((x) => digitos.includes(x.chave));
    if (!nota) throw new Error('não achei neste PDF a chave de acesso de nenhuma nota emitida por esta página.');
    if (nota.oficial) return res.json({ ok: true, numero: nota.numero, jaTinha: true, link: nota.oficial.link });
    const arquivo = path.join(__dirname, 'state', 'oficiais', `${nota.chave}.pdf`);
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.writeFileSync(arquivo, corpo);
    const d = await salvarNoDriveDela(arquivo, nomeArquivo(nota, nota.numero) + ' (nota oficial).pdf');
    registro.atualizar(nota.chave, { oficial: { link: d.link, id: d.id, em: new Date().toISOString() } });
    const pendencias = [];
    try { await trocarLinkNota(nota, d.link); } catch (e) { pendencias.push('planilha: ' + e.message); }
    const comprovanteId = nota.driveId || idDoLink(nota.drive);
    if (comprovanteId && !pendencias.length) {
      try { await apagarNoDriveDela(comprovanteId); registro.atualizar(nota.chave, { comprovanteApagado: true }); } catch (e) { pendencias.push('apagar comprovante: ' + e.message); }
    }
    console.log(`[oficial] NFS-e ${nota.numero}: DANFSe no Drive${pendencias.length ? ' · ' + pendencias.join(' | ') : ''}`);
    res.json({ ok: true, numero: nota.numero, link: d.link, pendencias });
  } catch (e) {
    console.log(`[oficial] ${nomeOriginal}: ${e.message}`);
    res.status(400).json({ ok: false, erro: e.message, arquivo: nomeOriginal });
  }
}

// Sem a barra final os caminhos relativos da página quebram: redireciona.
if (BASE_PATH) {
  app.use((req, res, next) => (req.path === BASE_PATH ? res.redirect(301, BASE_PATH + '/' + (req.url.split('?')[1] ? '?' + req.url.split('?')[1] : '')) : next()));
}
app.use(BASE_PATH || '/', rotas);

app.listen(PORTA, HOST, () => console.log(`Notas MEI: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORTA}${BASE_PATH}/`));
