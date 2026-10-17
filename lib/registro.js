// Registro local das notas emitidas por esta página (state/emitidas.json).
// Segunda trava contra emissão em dobro, além do nº gravado na planilha:
// se a gravação na planilha falhar, a linha continua aqui e não é emitida
// de novo.
const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'state', 'emitidas.json');

function ler() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO, 'utf8')); } catch (e) { return []; }
}

function adicionar(item) {
  const lista = ler();
  lista.push({ ...item, em: new Date().toISOString() });
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2));
}

function atualizar(chave, campos) {
  const lista = ler();
  const i = lista.findIndex((x) => x.chave === chave);
  if (i >= 0) { lista[i] = { ...lista[i], ...campos }; fs.writeFileSync(ARQUIVO, JSON.stringify(lista, null, 2)); }
}

// Já emitida por aqui? (mesmo contrato e valor)
const jaEmitida = (nota) => ler().find((x) => x.contrato === nota.contrato && Math.abs(x.comissao - nota.comissao) < 0.005);
const chaves = () => ler().map((x) => x.chave);

module.exports = { ler, adicionar, atualizar, jaEmitida, chaves };
