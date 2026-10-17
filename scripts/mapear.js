// MAPEAMENTO do Emissor Nacional (etapa 1): entra com login/senha do .env,
// lista o menu e abre a tela de emissão. NÃO emite nada: só navega por links
// (GET) e bloqueia qualquer envio (POST) depois do login.
//   node scripts/mapear.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://www.nfse.gov.br/EmissorNacional';
const STATE = path.join(__dirname, '..', 'state');
fs.mkdirSync(STATE, { recursive: true });

async function campos(page) {
  return page.locator('input:visible, select:visible, textarea:visible, button:visible').evaluateAll((els) => els.map((e) => {
    const rotulo = (e.labels && e.labels[0] ? e.labels[0].innerText : '') || e.getAttribute('aria-label') || e.placeholder || '';
    return [e.tagName.toLowerCase(), e.type || '', e.id || e.name || '', rotulo.trim().replace(/\s+/g, ' ').slice(0, 60), e.tagName === 'BUTTON' ? e.innerText.trim().slice(0, 40) : ''].filter(Boolean).join(' | ');
  }));
}

(async () => {
  if (!process.env.NFSE_NACIONAL_LOGIN || !process.env.NFSE_NACIONAL_SENHA) throw new Error('Preencha NFSE_NACIONAL_LOGIN e NFSE_NACIONAL_SENHA no .env');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.setDefaultTimeout(30000);
  let logado = false;
  await page.route('**/*', (r) => {
    if (logado && r.request().method() !== 'GET') {
      console.log('  (envio bloqueado:', r.request().method(), r.request().url().replace(BASE, ''), ')');
      return r.abort();
    }
    return r.continue();
  });

  await page.goto(`${BASE}/Login?ReturnUrl=%2femissornacional`, { waitUntil: 'networkidle' });
  await page.fill('#Inscricao', process.env.NFSE_NACIONAL_LOGIN);
  await page.fill('#Senha', process.env.NFSE_NACIONAL_SENHA);
  await Promise.all([page.waitForLoadState('networkidle'), page.locator('button[type=submit]', { hasText: 'Entrar' }).click()]);
  await page.waitForTimeout(2000);
  if (/\/Login/i.test(page.url())) {
    const aviso = (await page.locator('.alert, .validation-summary-errors, .field-validation-error, .text-danger').allInnerTexts()).join(' ').trim();
    await page.screenshot({ path: path.join(STATE, 'mapa-0-login.png') });
    throw new Error('Não entrou. Aviso do site: ' + (aviso || '(nenhum — ver state/mapa-0-login.png)'));
  }
  logado = true;
  console.log('ENTROU. Página:', page.url().replace(BASE, ''), '·', await page.title());
  await page.screenshot({ path: path.join(STATE, 'mapa-1-inicio.png'), fullPage: true });

  const links = await page.locator('a:visible').evaluateAll((as) => as.map((a) => [a.innerText.trim().replace(/\s+/g, ' '), a.getAttribute('href') || '']).filter(([t, h]) => t && h && !h.startsWith('http://') && !/^#/.test(h)));
  console.log('--- menu / links:');
  for (const [t, h] of links) console.log(`  ${t.slice(0, 50).padEnd(50)} ${h}`);

  // Tela de emissão: o link que fala em emitir/emissão.
  const emitir = links.find(([t, h]) => /emiss|emitir|DPS/i.test(t + ' ' + h) && !/consult|cancel/i.test(t));
  if (emitir) {
    console.log('--- abrindo:', emitir[0], emitir[1]);
    await page.goto(new URL(emitir[1], page.url()).href, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    console.log('Página:', page.url().replace(BASE, ''));
    console.log('Texto:', (await page.locator('main, #main-content, body').first().innerText()).replace(/\n\s*\n+/g, '\n').slice(0, 1500));
    console.log('--- campos:');
    for (const c of await campos(page)) console.log('  ' + c);
    await page.screenshot({ path: path.join(STATE, 'mapa-2-emissao.png'), fullPage: true });
  } else {
    console.log('Não achei link de emissão no menu — ver state/mapa-1-inicio.png');
  }
  await browser.close();
})().catch((e) => { console.log('ERRO', e.message.split('\n')[0]); process.exit(1); });
