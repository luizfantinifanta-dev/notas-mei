// Leitura da planilha "Controle MEI" (Google Sheets).
// Por enquanto lê pela exportação CSV pública (a planilha está aberta pelo
// link). A gravação do nº da nota virá por um workflow do n8n separado.
const fs = require('fs');
const path = require('path');

const PLANILHA_ID = process.env.PLANILHA_ID || '1af7XuLkmurHunWHCPAno9GdslwsyF_1tT0OmmrkseMU';
const CHAVE_PIX = 'chave PIX CPF 39692873838';

function lerCsv(texto) {
  const linhas = [];
  let linha = [], campo = '', aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i++; } else aspas = false; } else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; }
    else if (c === '\n') { linha.push(campo.replace(/\r$/, '')); linhas.push(linha); linha = []; campo = ''; }
    else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  return linhas;
}

// Nome da aba → gid (lido da visualização HTML da planilha).
async function gidsDasAbas() {
  const r = await fetch(`https://docs.google.com/spreadsheets/d/${PLANILHA_ID}/htmlview`, { signal: AbortSignal.timeout(30000) });
  const html = await r.text();
  const gids = {};
  for (const m of html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)", pageUrl: "[^"]*?gid=(\d+)/g)) {
    const nome = m[1].replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    gids[normalizar(nome)] = m[2];
  }
  return gids;
}

async function baixarAba(nome) {
  const gid = (await gidsDasAbas())[normalizar(nome)];
  if (!gid) throw new Error(`A planilha não tem a aba "${nome}".`);
  const url = `https://docs.google.com/spreadsheets/d/${PLANILHA_ID}/export?format=csv&gid=${gid}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const texto = await r.text();
  if (r.status !== 200 || /^\s*</.test(texto)) throw new Error(`Não consegui ler a aba "${nome}" (HTTP ${r.status}).`);
  return lerCsv(texto);
}

// "R$ 1.234,56" → 1234.56
function reais(v) {
  const t = String(v || '').replace(/[R$\s]/g, '');
  if (!t) return 0;
  return Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t) || 0;
}

// Datas vêm no formato da planilha (m/d/aaaa); devolve dd/mm/aaaa.
function dataBr(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v || '').trim());
  if (!m) return String(v || '').trim();
  return `${m[2].padStart(2, '0')}/${m[1].padStart(2, '0')}/${m[3]}`;
}

const formatarReais = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

function colunas(cabecalho) {
  const acha = (re) => cabecalho.findIndex((c) => re.test(normalizar(c)));
  return {
    status: acha(/^STATUS/),
    empresa: acha(/^EMPRESA$/),
    contrato: acha(/^CONTRATOS? FECHADOS?/),
    entrada: acha(/^ENTRADA$/),
    evento: acha(/^DATA DO EVENTO/),
    valor: acha(/^VALOR$/),
    comissao: acha(/^COMISSAO$/),
    nota: acha(/^N.? ?NFS-?E|^NUMERO DA NOTA|^NOTA FISCAL/),
    dataEmissao: acha(/^DATA (DE )?EMISSAO/),
  };
}

// Fornecedores (empresas que recebem as notas): aba "Fornecedores"; enquanto
// ela não existe, usa config/fornecedores.json.
async function lerFornecedores() {
  let lista = null;
  try {
    const linhas = await baixarAba('Fornecedores');
    const cab = linhas[0].map(normalizar);
    const i = (re) => cab.findIndex((c) => re.test(c));
    const iEmp = i(/^EMPRESA|^FORNECEDOR|^NOME$/), iCnpj = i(/CNPJ/), iRazao = i(/RAZAO/), iServ = i(/SERVICO/);
    if (iEmp >= 0 && iCnpj >= 0) {
      lista = linhas.slice(1).filter((l) => l[iEmp] && soDigitos(l[iCnpj]).length === 14).map((l) => ({
        empresa: l[iEmp].trim(), cnpj: soDigitos(l[iCnpj]), razao: iRazao >= 0 ? l[iRazao].trim() : '', servico: iServ >= 0 && l[iServ].trim() ? l[iServ].trim() : 'comissão vendas', origem: 'aba Fornecedores',
      }));
    }
  } catch (e) { /* aba ainda não existe */ }
  if (!lista || !lista.length) {
    lista = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'fornecedores.json'), 'utf8')).map((f) => ({ ...f, origem: 'config (provisório)' }));
  }
  return lista;
}

function descricao({ contrato, evento, comissao }) {
  return `${contrato} – evento ${evento} – cachê ${formatarReais(comissao)} – ${CHAVE_PIX}`;
}

// Linhas da aba "Comissão" com Status "Assinado" e sem nº de nota.
async function notasPendentes() {
  const [linhas, fornecedores] = await Promise.all([baixarAba('Comissão'), lerFornecedores()]);
  const cab = linhas[0];
  const c = colunas(cab);
  if (c.status < 0 || c.empresa < 0 || c.contrato < 0 || c.comissao < 0) throw new Error('Aba "Comissão": não achei as colunas Status / Empresa / Contratos Fechados / Comissão no cabeçalho.');
  const pendentes = [];
  linhas.forEach((l, i) => {
    if (i === 0 || normalizar(l[c.status]) !== 'ASSINADO') return;
    if (c.nota >= 0 && String(l[c.nota] || '').trim()) return; // já emitida
    const empresa = String(l[c.empresa] || '').trim();
    const f = fornecedores.find((x) => normalizar(x.empresa) === normalizar(empresa));
    const item = {
      linha: i + 1,
      empresa,
      contrato: String(l[c.contrato] || '').trim(),
      entrada: dataBr(l[c.entrada]),
      evento: dataBr(l[c.evento]),
      valorContrato: reais(l[c.valor]),
      comissao: reais(l[c.comissao]),
      fornecedor: f || null,
      problemas: [],
    };
    if (!f) item.problemas.push(`Empresa "${empresa || '(vazia)'}" não está nos fornecedores.`);
    if (!(item.comissao > 0)) item.problemas.push('Comissão vazia ou zero.');
    if (!item.contrato) item.problemas.push('Sem nome em "Contratos Fechados".');
    item.descricao = descricao(item);
    pendentes.push(item);
  });
  return { pendentes, fornecedores, colunaNota: c.nota >= 0 };
}

module.exports = { notasPendentes, lerFornecedores, descricao, reais, dataBr, lerCsv, formatarReais };
