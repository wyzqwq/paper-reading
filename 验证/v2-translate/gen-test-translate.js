// 生成单页英文测试 PDF（真实文本层，供 paper-reading app 翻译功能端到端测试）
// 内容：短学术短文，含 Fig.3 / et al. / 跨行长句 / 数字，测切句与偏移匹配。
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');

const TITLE = 'A Single-Page Test for Translation';
const BODY =
  'This is a single-page English document created to test the translation feature with minimal API cost. ' +
  'It contains several sentences of varying length and structure. ' +
  'As shown in Fig. 3, the proposed method converges within a few hundred steps. ' +
  'Prior work by Smith et al. established a comparable baseline on the same benchmark. ' +
  'When the learning rate is set to 0.01, the training loss decreases monotonically and stabilizes around 0.12. ' +
  'Sentences in real papers often wrap across multiple lines, as this sentence does, which exercises the offset matching between the extracted text and the translated sentences. ' +
  'We omit a full experimental evaluation here; the reader should focus on whether each sentence becomes clickable and shows a Chinese translation. ' +
  'This is the final sentence of the test document.';

// 按字号/最大宽度自动换行（pdf-lib 不自动换行）
function wrap(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(test, size) <= maxWidth) {
      line = test;
    } else {
      if (line) lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function main() {
  const doc = await PDFDocument.create();
  doc.setTitle(TITLE);
  doc.setAuthor('paper-reading test');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]); // US Letter, 单位 pt
  const margin = 56; // ~0.78in
  const maxWidth = 612 - margin * 2;
  let y = 792 - margin;

  // 标题
  page.drawText(TITLE, { x: margin, y, size: 16, font: fontBold, color: rgb(0.1, 0.1, 0.12) });
  y -= 26;
  // 分隔线
  page.drawLine({ start: { x: margin, y }, end: { x: 612 - margin, y }, thickness: 1, color: rgb(0.7, 0.7, 0.72) });
  y -= 22;

  // 正文（换行后逐行绘制，行距 1.45）
  const size = 12;
  const leading = size * 1.45;
  for (const line of wrap(BODY, font, size, maxWidth)) {
    if (y < margin) break; // 单页溢出保护
    page.drawText(line, { x: margin, y, size, font, color: rgb(0.13, 0.13, 0.15) });
    y -= leading;
  }

  const bytes = await doc.save();
  const out = __dirname + '/test-translate.pdf';
  fs.writeFileSync(out, bytes);
  console.log("written:", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
