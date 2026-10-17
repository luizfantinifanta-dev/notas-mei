// Notas MEI — salva no Drive os comprovantes das notas fiscais.
// Roda NA CONTA GOOGLE DELA (os arquivos ficam dela, no espaço dela).
// Só aceita envios com o SEGREDO abaixo (o mesmo do .env do robô).

const PASTA_ID = '1Bvz-B5L87TZY50ry0u8VpEBvIEd-aafa'; // pasta "Notas Mei"
const SEGREDO = 'COLE_AQUI_O_SEGREDO';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (!SEGREDO || SEGREDO === 'COLE_AQUI_O_SEGREDO' || d.segredo !== SEGREDO) return resposta({ ok: false, erro: 'não autorizado' });
    const pasta = DriveApp.getFolderById(PASTA_ID);
    // Mesmo nome já existe? Devolve o que está lá (não duplica).
    const existentes = pasta.getFilesByName(d.nome);
    if (existentes.hasNext()) {
      const f = existentes.next();
      return resposta({ ok: true, id: f.getId(), link: f.getUrl(), jaExistia: true });
    }
    const arquivo = Utilities.newBlob(Utilities.base64Decode(d.base64), d.tipo || 'application/pdf', d.nome);
    const f = pasta.createFile(arquivo);
    return resposta({ ok: true, id: f.getId(), link: f.getUrl() });
  } catch (err) {
    return resposta({ ok: false, erro: String(err) });
  }
}

function resposta(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Rodar UMA vez pelo editor (botão "Executar") para dar a autorização ao Drive.
function autorizar() {
  Logger.log('Pasta: ' + DriveApp.getFolderById(PASTA_ID).getName());
}
