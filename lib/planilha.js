// Planilha "Valores Mensais" (Google Sheets), lida com a conta de serviço
// notas-mei (lib/google.js).
//  - aba "Comissão": uma nota por linha com Status "Assinado" e sem Nº NFS-e;
//  - aba "Fornecedores": DEITADA — uma coluna por empresa, uma linha por
//    informação (Empresa, Nome:, CNPJ, Endereço…).
const { sheets } = require('./google');

const PLANILHA_ID = process.env.PLANILHA_ID || '1af7XuLkmurHunWHCPAno9GdslwsyF_1tT0OmmrkseMU';
const CHAVE_PIX = 'chave PIX CPF 39692873838';
const SERVICO_PADRAO = 'comissão vendas';

async function lerAba(intervalo) {
  const j = await sheets(`${PLANILHA_ID}/values/${encodeURIComponent(intervalo)}`);
  return j.values || [];
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
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/:$/, '').trim().toUpperCase();
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
const letraColuna = (i) => { let s = ''; for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };

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
    nota: acha(/^N.? ?NFS-?E/),
    dataEmissao: acha(/^DATA (DE )?EMISSAO/),
  };
}

async function lerFornecedores() {
  const linhas = await lerAba('Fornecedores!A1:Z40');
  const campo = (re) => linhas.find((l) => re.test(normalizar(l[0])));
  const empresas = campo(/^EMPRESA$/), nomes = campo(/^NOME$|^RAZAO/), cnpjs = campo(/^CNPJ/), servicos = campo(/^SERVICO/);
  if (!empresas || !cnpjs) throw new Error('Aba "Fornecedores": não achei as linhas "Empresa" e "CNPJ" na coluna A.');
  const lista = [];
  for (let i = 1; i < empresas.length; i++) {
    const empresa = String(empresas[i] || '').trim();
    if (!empresa) continue;
    lista.push({
      empresa,
      cnpj: soDigitos(cnpjs[i]),
      razao: nomes ? String(nomes[i] || '').trim() : '',
      servico: (servicos && String(servicos[i] || '').trim()) || SERVICO_PADRAO,
      problema: soDigitos(cnpjs[i]).length === 14 ? null : `CNPJ da empresa "${empresa}" vazio ou incompleto na aba Fornecedores.`,
    });
  }
  return lista;
}

function descricao({ contrato, evento, comissao }) {
  return `Comissão por venda de evento – ${contrato} – evento ${evento} – comissão ${formatarReais(comissao)} – ${CHAVE_PIX}`;
}

// Linhas da aba "Comissão" com Status "Assinado" e sem nº de nota.
async function notasPendentes() {
  const [linhas, fornecedores] = await Promise.all([lerAba('Comissão!A1:AZ'), lerFornecedores()]);
  const c = colunas(linhas[0] || []);
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
      fornecedor: f && !f.problema ? f : null,
      problemas: [],
    };
    if (!f) item.problemas.push(`Empresa "${empresa || '(vazia)'}" não está na aba Fornecedores.`);
    else if (f.problema) item.problemas.push(f.problema);
    if (!(item.comissao > 0)) item.problemas.push('Comissão vazia ou zero.');
    if (!item.contrato) item.problemas.push('Sem nome em "Contratos Fechados".');
    item.descricao = descricao(item);
    pendentes.push(item);
  });
  return {
    pendentes,
    fornecedores,
    colunaNota: c.nota >= 0 ? letraColuna(c.nota) : null,
    colunaDataEmissao: c.dataEmissao >= 0 ? letraColuna(c.dataEmissao) : null,
  };
}

// Grava "Nº NFS-e" (clicável → PDF no Drive) e "Data emissão" na linha da
// nota. Antes confere que a linha ainda é a mesma (mesmo contrato, Assinado,
// sem nº) — se alguém inseriu linhas no meio, procura o contrato de novo.
async function gravarEmissao(nota, { numero, dataIso, link }) {
  const linhas = await lerAba('Comissão!A1:AZ');
  const c = colunas(linhas[0] || []);
  if (c.nota < 0 || c.dataEmissao < 0) throw new Error('Aba "Comissão" sem as colunas "Nº NFS-e" / "Data emissão".');
  const confere = (l) => l && String(l[c.contrato] || '').trim() === nota.contrato && normalizar(l[c.status]) === 'ASSINADO' && !String(l[c.nota] || '').trim()
    && Math.abs(reais(l[c.comissao]) - nota.comissao) < 0.005;
  let i = nota.linha - 1;
  if (!confere(linhas[i])) {
    const achadas = linhas.map((l, k) => (k > 0 && confere(l) ? k : -1)).filter((k) => k >= 0);
    if (achadas.length !== 1) throw new Error(`Não achei com segurança a linha de "${nota.contrato}" para gravar a NFS-e ${numero}.`);
    i = achadas[0];
  }
  // Nº como texto com link embutido (fórmula HYPERLINK dá erro conforme a
  // região da planilha); data pela própria planilha (USER_ENTERED, aaaa-mm-dd).
  const meta = await sheets(`${PLANILHA_ID}?fields=sheets.properties(title,sheetId)`);
  const aba = meta.sheets.find((s) => s.properties.title === 'Comissão').properties.sheetId;
  const celula = { userEnteredValue: { stringValue: String(numero) } };
  if (link) celula.textFormatRuns = [{ startIndex: 0, format: { link: { uri: link } } }];
  await sheets(`${PLANILHA_ID}:batchUpdate`, {
    method: 'POST',
    body: { requests: [{ updateCells: { range: { sheetId: aba, startRowIndex: i, endRowIndex: i + 1, startColumnIndex: c.nota, endColumnIndex: c.nota + 1 }, rows: [{ values: [celula] }], fields: 'userEnteredValue,textFormatRuns' } }] },
  });
  await sheets(`${PLANILHA_ID}/values/${encodeURIComponent(`Comissão!${letraColuna(c.dataEmissao)}${i + 1}`)}?valueInputOption=USER_ENTERED`, { method: 'PUT', body: { values: [[dataIso]] } });
  return { linha: i + 1 };
}

module.exports = { gravarEmissao, notasPendentes, lerFornecedores, descricao, reais, dataBr, formatarReais, PLANILHA_ID };
