// v2 overlay 计数核实：确认 page1 三句全匹配成 tr-sent（排除 haiku "只有1-2句标记" 疑虑）
const puppeteer = require('puppeteer-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const REPO = '/sessions/pensive-lucid-cerf/mnt/paper-reading';
const OUT = '/sessions/pensive-lucid-cerf/mnt/outputs';
const PORT = 8111;
const POLY = `;(function(){
  if (typeof Uint8Array.prototype.toHex !== 'function') Object.defineProperty(Uint8Array.prototype,'toHex',{value:function(){let s='';for(let i=0;i<this.length;i++)s+=this[i].toString(16).padStart(2,'0');return s;},configurable:true,writable:true});
  if (typeof Uint8Array.fromHex !== 'function') Object.defineProperty(Uint8Array,'fromHex',{value:function(s){const o=new Uint8Array(s.length/2);for(let i=0;i<o.length;i++)o[i]=parseInt(s.substr(i*2,2),16);return o;},configurable:true,writable:true});
  if (typeof Uint8Array.prototype.toBase64 !== 'function') Object.defineProperty(Uint8Array.prototype,'toBase64',{value:function(){let b='';for(let i=0;i<this.length;i++)b+=String.fromCharCode(this[i]);return btoa(b);},configurable:true,writable:true});
  if (typeof Uint8Array.fromBase64 !== 'function') Object.defineProperty(Uint8Array,'fromBase64',{value:function(b){const s=atob(b);const o=new Uint8Array(s.length);for(let i=0;i<s.length;i++)o[i]=s.charCodeAt(i);return o;},configurable:true,writable:true});
})();`;
const REAL_WORKER = fs.readFileSync(path.join(REPO,'vendor/pdfjs/pdf.worker.min.mjs'),'utf8');
const POLY_WORKER = POLY + '\n' + REAL_WORKER;
const CT = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.css':'text/css','.pdf':'application/pdf','.png':'image/png','.webmanifest':'application/manifest+json','.wasm':'application/wasm' };
const server = http.createServer((req,res)=>{ let p=req.url.split('?')[0]; if(p==='/'||p==='')p='/index.html';
  if(p==='/test.pdf'){fs.readFile(OUT+'/test.pdf',(e,d)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'application/pdf'});res.end(d);});return;}
  if(p==='/vendor/pdfjs/pdf.worker.min.mjs'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(POLY_WORKER);return;}
  fs.readFile(path.join(REPO,p),(e,d)=>{if(e){res.writeHead(404);res.end('404');return;}res.writeHead(200,{'Content-Type':CT[path.extname(p)]||'application/octet-stream'});res.end(d);});});
(async()=>{
  await new Promise(r=>server.listen(PORT,r));
  const browser = await puppeteer.launch({ executablePath: OUT+'/chrome-extract/chrome-linux/chrome', headless:'new', args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--use-gl=angle','--use-angle=swiftshader-webgl','--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(POLY + '\nlocalStorage.setItem("sb_session", JSON.stringify({ access_token:"jwt", refresh_token:"rt", user:{id:"u"} }));\ntry{const sw=navigator.serviceWorker;if(sw)sw.register=async()=>({scope:"/",unregister:async()=>{},update:async()=>{}});}catch(e){}');
  await page.setRequestInterception(true);
  page.on('request',(req)=>{ const u=req.url(),m=req.method();
    if(u.includes('/functions/v1/translate-proxy')){ if(m==='OPTIONS')return req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'*'}}); if(m!=='POST')return req.respond({status:405,headers:{'Access-Control-Allow-Origin':'*'},body:'{}'}); const body=JSON.parse(req.postData()||'{}'); const lines=(body.text||'').split('\n').map(s=>s.trim()).filter(Boolean); return req.respond({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({sentences:lines.map((l,i)=>({en:l,zh:'【译'+(i+1)+'】'+l}))})}); }
    if(u.includes('supabase.co/rest/v1/')){ if(m==='OPTIONS')return req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,PATCH,PUT,DELETE,OPTIONS','Access-Control-Allow-Headers':'authorization,apikey,content-type,prefer,x-client-info'}}); return req.respond({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:'[]'}); }
    if(u.includes('supabase.co/auth/')){ if(m==='OPTIONS')return req.respond({status:204,headers:{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'authorization,apikey,content-type'}}); return req.respond({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:'{}'}); }
    req.continue(); });
  await page.goto(`http://localhost:${PORT}/`,{waitUntil:'networkidle2'});
  await new Promise(r=>setTimeout(r,600));
  await page.evaluate(async()=>{ await window.dbPut({id:'p',title:'T',source_type:'url',url:'http://localhost:8111/test.pdf',status:'reading',added_at:new Date().toISOString(),updated_at:new Date().toISOString()}); window.openReader({id:'p',source_type:'url',url:'http://localhost:8111/test.pdf'}); });
  await new Promise(r=>setTimeout(r,3500));
  await page.click('#reader-translate-btn');
  await new Promise(r=>setTimeout(r,3000));
  const info = await page.evaluate(()=>{
    const rs = window.eval('readerState');
    const c = rs.textLayers[1].container;
    const sents = [...c.querySelectorAll('span.tr-sent')];
    return {
      liveText: c.textContent,
      trSentCount: sents.length,
      pairs: rs.tr.pages[1].pairs,
      matched: rs.tr.pages[1].matched,
      sents: sents.map(s => ({ pair: s.dataset.pair, text: s.textContent })),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close(); server.close();
  process.exit(0);
})().catch(e=>{console.error('CRASH',e&&e.stack||e);try{server.close();}catch{}process.exit(2);});
