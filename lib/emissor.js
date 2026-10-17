// Robô do Emissor Nacional (nfse.gov.br) — emissão simplificada.
// Nesta fase SÓ PREENCHE e confere: qualquer envio de formulário ao site é
// bloqueado (modo teste). A emissão de verdade será liberada depois.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE = 'https://www.nfse.gov.br/EmissorNacional';
const STATE = path.join(__dirname, '..', 'state');
fs.mkdirSync(STATE, { recursive: true });

const reaisTexto = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

class Emissor {
  constructor({ visivel = false } = {}) {
    this.visivel = visivel;
    this.browser = null;
    this.page = null;
    this.bloqueados = [];
  }

  async abrir() {
    if (!process.env.NFSE_NACIONAL_LOGIN || !process.env.NFSE_NACIONAL_SENHA) throw new Error('Preencha NFSE_NACIONAL_LOGIN e NFSE_NACIONAL_SENHA no .env');
    this.browser = await chromium.launch({ headless: !this.visivel });
    this.page = await this.browser.newPage({ viewport: { width: 1400, height: 1000 } });
    this.page.setDefaultTimeout(30000);
    let logado = false;
    // Depois do login, nada além de consultas (GET) chega ao site — exceto o
    // ÚNICO envio liberado por enviosLiberados (o "Emitir NFS-e").
    this.enviosLiberados = 0;
    this.enviados = [];
    await this.page.route('**/*', (r) => {
      const q = r.request();
      if (logado && q.method() !== 'GET' && this.enviosLiberados > 0 && /\/EmissorNacional\/DPS\/Simplificada/i.test(q.url())) {
        this.enviosLiberados--;
        this.enviados.push(`${q.method()} ${q.url().replace(/^https:\/\/www\.nfse\.gov\.br/i, '')}`);
        return r.continue();
      }
      if (logado && q.method() !== 'GET') {
        if (!/\/rb_/.test(q.url())) this.bloqueados.push(`${q.method()} ${q.url().replace(/^https:\/\/www\.nfse\.gov\.br/i, '')}`);
        return r.abort();
      }
      return r.continue();
    });
    await this.page.goto(`${BASE}/Login?ReturnUrl=%2femissornacional`, { waitUntil: 'networkidle' });
    await this.page.fill('#Inscricao', process.env.NFSE_NACIONAL_LOGIN);
    await this.page.fill('#Senha', process.env.NFSE_NACIONAL_SENHA);
    await Promise.all([
      this.page.waitForURL((u) => !/\/Login/i.test(u.pathname), { timeout: 30000 }).catch(() => {}),
      this.page.locator('button[type=submit]', { hasText: 'Entrar' }).click(),
    ]);
    if (/\/Login/i.test(new URL(this.page.url()).pathname)) {
      const aviso = (await this.page.locator('.alert:visible, .validation-summary-errors:visible, .text-danger:visible').allInnerTexts()).join(' ').trim();
      throw new Error('Não consegui entrar no Emissor Nacional. ' + (aviso || 'Confira login e senha no .env.'));
    }
    logado = true;
  }

  async fechar() {
    if (this.browser) await this.browser.close().catch(() => {});
    this.browser = null;
  }

  // Preenche a emissão simplificada com a nota e confere campo a campo.
  // Devolve { diferencas, avisos, tela } — NÃO clica em "Emitir NFS-e".
  async preencher(nota) {
    const p = this.page;
    const f = nota.fornecedor;
    if (!f) throw new Error(`Empresa "${nota.empresa}" sem cadastro nos fornecedores.`);
    await p.goto(`${BASE}/DPS/Simplificada`, { waitUntil: 'networkidle' });

    // Cliente: CNPJ + lupa (o site preenche a razão social).
    await p.fill('#InscricaoCliente', f.cnpj);
    await p.click('#btn_InscricaoCliente_pesquisar');
    await p.waitForFunction(() => document.querySelector('#NomeCliente').value.trim() !== '', null, { timeout: 20000 });

    // Serviço favorito (lista "chosen": troca o <select> escondido e avisa).
    const opcoes = await p.locator('#IdServicoFavorito option').evaluateAll((os) => os.map((o) => ({ v: o.value, t: o.text.trim() })));
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const servico = opcoes.find((o) => o.v && norm(o.t) === norm(f.servico));
    if (!servico) throw new Error(`Serviço favorito "${f.servico}" não existe no Emissor Nacional (há: ${opcoes.filter((o) => o.v).map((o) => o.t).join(', ')}).`);
    await p.evaluate((v) => {
      const $ = window.jQuery;
      $('#IdServicoFavorito').val(v).trigger('chosen:updated').trigger('change');
    }, servico.v);
    await p.waitForFunction(() => !document.querySelector('#btnDescricao').disabled, null, { timeout: 15000 });
    await p.waitForTimeout(800);

    // Descrição só desta nota (lápis).
    if (!(await p.locator('#pnlDescricao').isVisible())) await p.click('#btnDescricao');
    await p.locator('#Descricao').waitFor({ state: 'visible' });
    // O site carrega o texto do favorito no campo logo depois de abrir —
    // espera ele chegar (e parar de mudar) antes de substituir.
    let anterior = null;
    for (let i = 0; i < 20; i++) {
      const v = await p.inputValue('#Descricao');
      if (v && v === anterior) break;
      anterior = v;
      await p.waitForTimeout(300);
    }
    this.descricaoPadrao = await p.inputValue('#Descricao');
    await p.fill('#Descricao', nota.descricao);
    await p.waitForTimeout(800);
    if ((await p.inputValue('#Descricao')) !== nota.descricao) await p.fill('#Descricao', nota.descricao);
    // Avisa a página como se tivesse digitado (contador de caracteres e validação).
    await p.locator('#Descricao').press('End');
    await p.evaluate(() => { const $ = window.jQuery; $('#Descricao').trigger('keyup').trigger('change'); });

    // Valor (campo com máscara: digita os centavos).
    await p.click('#ValorServico');
    await p.fill('#ValorServico', '');
    await p.locator('#ValorServico').pressSequentially(String(Math.round(nota.comissao * 100)), { delay: 40 });
    await p.locator('#ValorServico').blur();
    await p.waitForTimeout(500);

    // Conferência do que ficou na tela.
    const lido = await p.evaluate(() => ({
      cnpj: document.querySelector('#InscricaoCliente').value,
      nome: document.querySelector('#NomeCliente').value,
      servico: (document.querySelector('#IdServicoFavorito_chosen .chosen-single span') || {}).textContent || '',
      descricao: document.querySelector('#Descricao').value,
      valor: document.querySelector('#ValorServico').value,
    }));
    const diferencas = [];
    if (soDigitos(lido.cnpj) !== f.cnpj) diferencas.push(`CNPJ na tela ${lido.cnpj}`);
    // A razão social vem da Receita pelo CNPJ (pode diferir da planilha, ex.
    // EIRELI → LTDA): só avisa. Quem garante a empresa certa é o CNPJ.
    const avisos = [];
    if (f.razao && norm(lido.nome) !== norm(f.razao)) avisos.push(`no site: "${lido.nome}" (planilha: "${f.razao}")`);
    if (norm(lido.servico) !== norm(f.servico)) diferencas.push(`serviço na tela "${lido.servico}"`);
    if (lido.descricao !== nota.descricao) diferencas.push('descrição diferente');
    if (soDigitos(lido.valor) !== soDigitos(reaisTexto(nota.comissao))) diferencas.push(`valor na tela ${lido.valor} (esperado ${reaisTexto(nota.comissao)})`);

    const tela = path.join(STATE, `preenchida-linha-${nota.linha}.png`);
    await p.screenshot({ path: tela, fullPage: true });
    return { lido, diferencas, avisos, tela };
  }

  // Comprovante de uma nota já emitida: abre "Visualizar NFS-e" (só consulta)
  // e salva a página em PDF + imagem. O site recusa o download do DANFSe pelo
  // robô (403), então este é o registro guardado. Devolve os dados lidos.
  async comprovante(chave, nomeArquivo) {
    const p = this.page;
    await p.goto(`${BASE}/Notas/Visualizar/Index/${chave}`, { waitUntil: 'networkidle' });
    const dados = await p.evaluate(() => {
      const r = {};
      document.querySelectorAll('label, .control-label').forEach((l) => {
        const t = l.innerText.trim();
        const n = l.nextElementSibling || (l.parentElement && l.parentElement.querySelector('span,div,p'));
        if (t && n && !(t in r)) r[t] = (n.value || n.innerText || '').replace(/\s+/g, ' ').trim();
      });
      return r;
    });
    // Nº da NFS-e = posições 24–36 da chave de acesso (layout nacional:
    // município 7, ambiente 1, tipo inscr. 1, CNPJ 14, nNFSe 13, AAMM 4,
    // código 9, DV 1). O "Número" da tela é o da DPS, NÃO o da nota.
    if (!/^\d{50}$/.test(chave)) throw new Error(`Chave de acesso inválida: ${chave}`);
    const numero = String(Number(chave.slice(23, 36)));
    const numeroDps = (dados['Número'] || '').replace(/\D/g, '');
    const base = path.join(STATE, 'notas', nomeArquivo || `NFSe-${numero}`);
    fs.mkdirSync(path.dirname(base), { recursive: true });
    // Todas as abas (NFS-e, Pessoas, Serviço, Outros Tributos) no comprovante.
    await p.evaluate(() => {
      document.querySelectorAll('.tab-pane').forEach((t) => {
        const id = t.id;
        const aba = id && document.querySelector(`a[href="#${id}"]`);
        const titulo = document.createElement('h3');
        titulo.textContent = aba ? aba.innerText.trim() : '';
        titulo.style.cssText = 'margin:18px 0 6px;color:#3d7a4f';
        t.classList.add('active', 'in', 'show');
        t.style.display = 'block';
        if (titulo.textContent) t.prepend(titulo);
      });
    });
    await p.emulateMedia({ media: 'screen' });
    await p.pdf({ path: base + '.pdf', format: 'A4', printBackground: true, margin: { top: '10mm', bottom: '10mm', left: '8mm', right: '8mm' }, scale: 0.75 });
    await p.screenshot({ path: base + '.png', fullPage: true });
    return { numero, numeroDps, dataEmissao: dados['Data de emissão'] || '', situacao: dados['Situação da NFS-e'] || '', valor: dados['Valor do Serviço'] || '', pdf: base + '.pdf', imagem: base + '.png' };
  }
}

module.exports = { Emissor };
