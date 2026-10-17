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
    // MODO TESTE: depois do login, nada além de consultas (GET) chega ao site.
    await this.page.route('**/*', (r) => {
      const q = r.request();
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
  // Devolve { diferencas, tela } — NÃO clica em "Emitir NFS-e".
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
    if (f.razao && norm(lido.nome) !== norm(f.razao)) diferencas.push(`razão social na tela "${lido.nome}" (cadastro: "${f.razao}")`);
    if (norm(lido.servico) !== norm(f.servico)) diferencas.push(`serviço na tela "${lido.servico}"`);
    if (lido.descricao !== nota.descricao) diferencas.push('descrição diferente');
    if (soDigitos(lido.valor) !== soDigitos(reaisTexto(nota.comissao))) diferencas.push(`valor na tela ${lido.valor} (esperado ${reaisTexto(nota.comissao)})`);

    const tela = path.join(STATE, `preenchida-linha-${nota.linha}.png`);
    await p.screenshot({ path: tela, fullPage: true });
    return { lido, diferencas, tela };
  }
}

module.exports = { Emissor };
