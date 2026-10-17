// Acesso ao Google (Sheets) com a conta de serviço notas-mei — chave em
// google-chave.json (ou no caminho de GOOGLE_CHAVE). Sem bibliotecas extras:
// assina o JWT e troca por um token de acesso.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ESCOPOS = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';
let chave = null;
let token = null;

function lerChave() {
  if (!chave) {
    const arquivo = process.env.GOOGLE_CHAVE || path.join(__dirname, '..', 'google-chave.json');
    if (!fs.existsSync(arquivo)) throw new Error('Falta a chave da conta de serviço do Google (google-chave.json).');
    chave = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  }
  return chave;
}

const b64url = (x) => Buffer.from(x).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function tokenDeAcesso() {
  if (token && token.expira > Date.now() + 60000) return token.valor;
  const k = lerChave();
  const agora = Math.floor(Date.now() / 1000);
  const cab = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = b64url(JSON.stringify({ iss: k.client_email, scope: ESCOPOS, aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 }));
  const assinatura = crypto.createSign('RSA-SHA256').update(`${cab}.${corpo}`).sign(k.private_key);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${corpo}.${b64url(assinatura)}` }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Google recusou a conta de serviço: ' + (j.error_description || j.error || r.status));
  token = { valor: j.access_token, expira: Date.now() + j.expires_in * 1000 };
  return token.valor;
}

async function sheets(caminho, { method = 'GET', body } = {}) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${caminho}`, {
    method,
    headers: { authorization: `Bearer ${await tokenDeAcesso()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`Google Sheets respondeu ${r.status}: ${(j.error && j.error.message) || ''}`);
  return j;
}

module.exports = { sheets, tokenDeAcesso, emailDaConta: () => lerChave().client_email };

// Envia um arquivo para uma pasta do Drive. Devolve { id, link }.
async function enviarAoDrive(caminho, { pasta, nome, tipo = 'application/pdf' }) {
  const meta = JSON.stringify({ name: nome || path.basename(caminho), parents: [pasta] });
  const limite = 'notasmei' + crypto.randomBytes(8).toString('hex');
  const corpo = Buffer.concat([
    Buffer.from(`--${limite}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${limite}\r\ncontent-type: ${tipo}\r\n\r\n`),
    fs.readFileSync(caminho),
    Buffer.from(`\r\n--${limite}--`),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink', {
    method: 'POST',
    headers: { authorization: `Bearer ${await tokenDeAcesso()}`, 'content-type': `multipart/related; boundary=${limite}` },
    body: corpo,
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json();
  if (r.status !== 200) throw new Error(`Drive respondeu ${r.status}: ${(j.error && j.error.message) || ''}`);
  return { id: j.id, link: j.webViewLink };
}

module.exports.enviarAoDrive = enviarAoDrive;
