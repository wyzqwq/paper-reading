// 生成测试 PDF（2 页，每行一句英文，pdf-lib 单次 drawText = pdf.js 一个 text item）
const { PDFDocument, StandardFonts } = require('pdf-lib');
const fs = require('fs');
(async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [
    ['Hello world.', 'This is a test.', 'Fig. 3 shows the result.'],
    ['Second page here.', 'Machine learning is fun.'],
  ];
  for (const lines of pages) {
    const page = doc.addPage([600, 800]);
    let y = 720;
    for (const ln of lines) { page.drawText(ln, { x: 50, y, size: 18, font }); y -= 32; }
  }
  fs.writeFileSync('/sessions/pensive-lucid-cerf/mnt/outputs/test.pdf', await doc.save());
  console.log('test.pdf 生成', pages.flat().length, '句');
})().catch((e) => { console.error(e); process.exit(1); });
