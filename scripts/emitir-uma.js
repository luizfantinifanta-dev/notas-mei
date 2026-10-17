// PRIMEIRA EMISSÃO REAL, acompanhada (uma linha só):
//   node scripts/emitir-uma.js <linha>
// Confere se já não há nota recente igual, preenche, confere, libera UM envio
// e clica "Emitir NFS-e". Se aparecer confirmação, NÃO responde: fotografa e
// para. Registra tudo o que aparece depois (para mapear o fim do fluxo).
const fs = require('fs');
const path = require('path');
const { notasPendentes } = require('../lib/planilha');
const { Emissor } = require('../lib/emissor');

const STATE = path.join(__dirname, '..', 'state');
const linha = Number(process.argv[2]);

(async () => {
  if (!linha) throw new Error('Informe a linha.');
  const { pendentes } = await notasPendentes();
  const nota = pendentes.find((n) => n.linha === linha);
  if (!nota) throw new Error(`Linha ${linha} não está entre as "Assinado" sem nota.`);
  if (nota.problemas.length) throw new Error(nota.problemas.join(' '));
  console.log(`linha ${linha}: ${nota.empresa} (${nota.fornecedor.cnpj}) · ${nota.comissao} · ${nota.descricao}`);

  const e = new Emissor();
  const p = () => e.page;
  try {
    await e.abrir();

    // 1. Já existe nota recente para o mesmo CNPJ e valor?
    const recentes = await p().locator('body').innerText();
    const cnpjFmt = nota.fornecedor.cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    const valorFmt = nota.comissao.toLocaleString('pt-BR', { minimumFractionDigits: 2 });
    const bloco = recentes.split('Últimas NFS-e emitidas')[1] || '';
    const linhasBloco = bloco.split(/\n(?=\d{2}\/\d{2}\/\d{4})/);
    const igual = linhasBloco.find((t) => t.includes(cnpjFmt) && t.includes(valorFmt));
    if (igual) throw new Error(`Já existe nota recente para ${cnpjFmt} de R$ ${valorFmt}: ${igual.replace(/\s+/g, ' ').trim()}`);
    console.log('1. nenhuma nota recente igual (mesmo CNPJ e valor).');

    // 2. Preenche e confere.
    const r = await e.preencher(nota);
    if (r.diferencas.length) throw new Error('Preenchimento não conferiu: ' + r.diferencas.join('; '));
    console.log('2. preenchido e conferido.', r.avisos.length ? 'aviso: ' + r.avisos.join('; ') : '');

    // 3. Um envio liberado + clique.
    const dialogos = [];
    p().on('dialog', async (d) => {
      dialogos.push(`${d.type()}: ${d.message()}`);
      console.log(`   CAIXA DO NAVEGADOR (${d.type()}): ${d.message()} — NÃO respondida`);
      await d.dismiss().catch(() => {});
    });
    e.enviosLiberados = 1;
    await p().locator('button[type=submit]', { hasText: 'Emitir NFS-e' }).click();
    console.log('3. clicou em "Emitir NFS-e".');
    await p().waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await p().waitForTimeout(3000);
    e.enviosLiberados = 0;

    // 4. O que apareceu.
    const url = p().url();
    const texto = (await p().locator('main, #main-content, body').first().innerText()).replace(/\n\s*\n+/g, '\n');
    const modal = await p().locator('.modal:visible').allInnerTexts();
    const botoes = await p().locator('button:visible, a.btn:visible').evaluateAll((bs) => bs.map((b) => (b.innerText || b.title || b.getAttribute('data-original-title') || '').trim()).filter(Boolean));
    const links = await p().locator('a').evaluateAll((as) => as.map((a) => `${(a.innerText || a.title || a.getAttribute('data-original-title') || '').trim()} → ${a.getAttribute('href')}`).filter((x) => /pdf|xml|download|danfs|visualizar|imprimir/i.test(x)));
    await p().screenshot({ path: path.join(STATE, `emissao-linha-${linha}.png`), fullPage: true });
    fs.writeFileSync(path.join(STATE, `emissao-linha-${linha}.html`), await p().content());
    console.log('4. depois do clique:');
    console.log('   envios que passaram:', e.enviados.join(' | ') || 'nenhum');
    console.log('   envios bloqueados:', e.bloqueados.join(' | ') || 'nenhum');
    console.log('   caixas do navegador:', dialogos.join(' | ') || 'nenhuma');
    console.log('   url:', url);
    console.log('   janela (modal):', modal.join(' | ').replace(/\s+/g, ' ') || 'nenhuma');
    console.log('   botões:', botoes.join(' · '));
    console.log('   links de nota:', links.join(' · ') || 'nenhum');
    console.log('   texto:', texto.slice(0, 1500));
  } finally {
    await e.fechar();
  }
})().catch((err) => { console.log('PAROU:', err.message.split('\n')[0]); process.exit(1); });
