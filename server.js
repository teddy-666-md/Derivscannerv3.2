const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT) || 10000;
const PUBLIC = path.join(__dirname, "public");
const MAX_HTML = 12 * 1024 * 1024;
const TIMEOUT = 25000;
const jobs = new Map();

function send(res, status, body, type="text/plain; charset=utf-8", extra={}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    ...extra
  });
  res.end(body);
}
function json(res,status,data){send(res,status,JSON.stringify(data),"application/json; charset=utf-8")}
function cleanUrl(raw){
  let s=String(raw||"").trim();
  if(!s) throw Error("URL is required");
  if(!/^https?:\/\//i.test(s)) s="https://"+s;
  const u=new URL(s); u.hash="";
  if(!["http:","https:"].includes(u.protocol)) throw Error("Only HTTP/HTTPS URLs are supported");
  return u.toString();
}
function normalizeUrl(raw,base){
  try{
    let s=String(raw||"").trim().replace(/^['"`]|['"`]$/g,"");
    if(!s || /^(javascript|mailto|tel|data|blob):/i.test(s)) return null;
    return new URL(s,base).toString();
  }catch{return null}
}
function nameFromUrl(u){
  try{
    const x=new URL(u);
    const f=decodeURIComponent(x.pathname.split("/").pop()||"").replace(/\.[^.]+$/,"");
    return (f||x.hostname).replace(/[-_]+/g," ").replace(/\s+/g," ").trim();
  }catch{return "Trading Bot"}
}
function classify(text,url){
  const s=(text+" "+url).toLowerCase();
  const special=/(special|custom block|custom blocks|advanced block|exclusive|does not work on normal|not normal deriv|proprietary)/i.test(s);
  return special ? "Special" : "Standard";
}
function isBotCandidate(text,url){
  const s=(text+" "+url).toLowerCase();
  return /\.xml(?:[?#]|$)/i.test(url) ||
    /(bot|bots|strategy|strategies|binary|deriv|dbot|freebot|trading bot|automated bot|download)/i.test(s);
}
function extractCandidates(records){
  const map=new Map();
  const add=(url,label,source,context="")=>{
    if(!url || !isBotCandidate(label,url)) return;
    try{
      const u=new URL(url);
      if(!/^https?:$/.test(u.protocol)) return;
      const key=u.toString();
      if(!map.has(key)){
        map.set(key,{
          url:key,
          name:(label||"").replace(/\s+/g," ").trim().slice(0,180)||nameFromUrl(key),
          type:/\.xml(?:[?#]|$)/i.test(key)?"XML":"Candidate",
          category:classify(label, key),
          source
        });
      }
    }catch{}
  };
  for(const r of records){
    add(r.url,r.text,r.source,r.context);
  }
  return [...map.values()].slice(0,500);
}
function collectFromPageData(data){
  const out=[];
  const push=(url,text,source,context="")=>out.push({url,text,source,context});
  for(const a of data.links||[]) push(a.url,a.text||a.aria||"","link",a.outer||"");
  for(const f of data.frames||[]) push(f.url,"iframe","iframe","");
  for(const s of data.scripts||[]) push(s.src||"", "script", "script", "");
  for(const e of data.embedded||[]) push(e.url,e.text||"embedded","embedded",e.context||"");
  for(const x of data.xmls||[]) push(x.url,x.text||"XML","xml",x.context||"");
  return out;
}
async function scanSite(raw){
  const target=cleanUrl(raw);
  const browser=await chromium.launch({headless:true,args:["--no-sandbox","--disable-setuid-sandbox"]});
  const context=await browser.newContext({
    userAgent:"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
    viewport:{width:1440,height:1200}
  });
  const page=await context.newPage();
  const records=[];
  const seenRecords=new Set();
  const addRecord=(url,text,source,contextText="")=>{
    if(!url) return;
    try{
      const u=new URL(url);
      if(!/^https?:$/.test(u.protocol)) return;
      const key=u.toString()+"|"+String(text).trim().slice(0,120)+"|"+source;
      if(!seenRecords.has(key)){seenRecords.add(key);records.push({url:u.toString(),text:String(text||"").trim(),source,context:contextText});}
    }catch{}
  };
  const responseUrls=[];
  page.on("response", async response=>{
    try{
      const u=response.url();
      const ct=(response.headers()["content-type"]||"").toLowerCase();
      if(response.request().resourceType()==="xhr" || response.request().resourceType()==="fetch" || /json|xml|javascript|html/.test(ct)){
        responseUrls.push(u);
        const reqUrl=new URL(u);
        if(/\.xml(?:$|[?#])/i.test(reqUrl.pathname+reqUrl.search)) addRecord(u,"XML network response","network");
        if(/bot|strategy|download|binary|deriv/i.test(u)) addRecord(u,"Bot-related network request","network");
        if(/json|javascript|html/.test(ct) && response.request().resourceType()!=="image"){
          const text=await response.text().catch(()=> "");
          if(text && text.length<15000000){
            const urlRe=/https?:\/\/[^\s"'<>\\]+/gi;
            for(const m of text.matchAll(urlRe)) addRecord(m[0].replace(/[),.;]+$/,""),"Embedded network URL","network");
            const xmlRe=/["'`]\s*([^"'`\\\s]+\.xml(?:\?[^"'`\\\s]*)?)\s*["'`]/gi;
            for(const m of text.matchAll(xmlRe)){
              addRecord(normalizeUrl(m[1],u),"XML reference","network");
            }
            const keyRe=/["'](?:url|href|download|downloadUrl|file|xml|bot|botUrl|strategyUrl)["']\s*:\s*["']([^"']+)["']/gi;
            for(const m of text.matchAll(keyRe)) addRecord(normalizeUrl(m[1],u),"Embedded bot data","network");
          }
        }
      }
    }catch{}
  });

  const visited=new Set(), queue=[{url:target,depth:0}], maxPages=10;
  try{
    while(queue.length && visited.size<maxPages){
      const item=queue.shift();
      let u;
      try{u=new URL(item.url);u.hash=""}catch{continue}
      const key=u.toString();
      if(visited.has(key))continue;
      visited.add(key);
      try{
        await page.goto(key,{waitUntil:"domcontentloaded",timeout:TIMEOUT});
        await page.waitForTimeout(3500);
        // Scroll so lazy-loaded bot cards appear.
        await page.evaluate(async()=>{
          for(let i=0;i<5;i++){window.scrollTo(0,document.body.scrollHeight);await new Promise(r=>setTimeout(r,500));}
          window.scrollTo(0,0);
        });
        await page.waitForTimeout(1000);
      }catch(e){
        addRecord(key,"","page-error",e.message);
        continue;
      }

      const data=await page.evaluate(()=>{
        const out={links:[],frames:[],scripts:[],xmls:[],embedded:[],cards:[]};
        const txt=e=>(e.innerText||e.textContent||"").replace(/\s+/g," ").trim();
        for(const a of document.querySelectorAll("a[href],area[href]")){
          out.links.push({url:a.href,text:txt(a),aria:a.getAttribute("aria-label")||"",outer:a.outerHTML.slice(0,1500)});
        }
        for(const f of document.querySelectorAll("iframe[src],frame[src]"))out.frames.push({url:f.src});
        for(const s of document.scripts)if(s.src)out.scripts.push({src:s.src});
        const html=document.documentElement.outerHTML;
        for(const m of html.matchAll(/https?:\/\/[^\s"'<>\\]+/gi))out.embedded.push({url:m[0].replace(/[),.;]+$/,""),text:"embedded"});
        for(const m of html.matchAll(/["'`](?!javascript:)([^"'`\\\s]+\.xml(?:\?[^"'`\\\s]*)?)["'`]/gi))out.xmls.push({url:m[1],text:"XML"});
        // Visible bot/catalog cards: buttons, articles, list items, divs with bot-like names.
        const els=[...document.querySelectorAll("article,li,section,button,a,[role=button],[data-id],[data-bot-id],[class*=bot],[class*=product],[class*=strategy]")];
        for(const e of els){
          const t=txt(e);
          if(!t || t.length<3 || t.length>500) continue;
          const low=t.toLowerCase();
          if(/bot|strategy|binary|deriv|freebot|trading|automated/.test(low)){
            let href=e.href||e.getAttribute("data-href")||e.getAttribute("data-url")||e.getAttribute("data-download")||"";
            let id=e.getAttribute("data-id")||e.getAttribute("data-bot-id")||"";
            out.cards.push({text:t,href,id,html:e.outerHTML.slice(0,3000)});
          }
        }
        return out;
      });

      for(const a of data.links) addRecord(a.url,a.text||a.aria,"link",a.outer);
      for(const x of data.frames) addRecord(x.url,"iframe","iframe");
      for(const x of data.scripts) addRecord(x.src,"script","script");
      for(const x of data.embedded) addRecord(normalizeUrl(x.url,key),x.text,"embedded");
      for(const x of data.xmls) addRecord(normalizeUrl(x.url,key),x.text,"xml");
      for(const c of data.cards){
        const abs=normalizeUrl(c.href,key);
        // Catalog entries without direct href are still returned as candidates.
        if(abs) addRecord(abs,c.text,"catalog-card",c.html);
        else records.push({url:key,text:c.text,source:"catalog-card",context:c.html});
      }

      for(const f of data.frames){
        const fu=normalizeUrl(f.url,key);
        if(fu && item.depth<2) queue.push({url:fu,depth:item.depth+1});
      }
      for(const a of data.links){
        const au=normalizeUrl(a.url,key);
        if(!au)continue;
        try{
          const x=new URL(au), b=new URL(target);
          const promising=/(bot|strategy|download|freebot|binary|deriv)/i.test((a.text||"")+" "+au);
          if(x.hostname===b.hostname && promising && item.depth<2) queue.push({url:au,depth:item.depth+1});
        }catch{}
      }
    }

    // Convert records into a catalog. Items with no direct file URL are retained as "Catalog".
    const map=new Map();
    for(const r of records){
      const text=r.text.replace(/\s+/g," ").trim();
      const looksFile=/\.xml(?:$|[?#])/i.test(r.url);
      const looksBot=/(bot|strategy|binary|deriv|freebot|trading|automated)/i.test(text+" "+r.url);
      if(!looksFile && !looksBot)continue;
      let url=r.url;
      // A page URL from a catalog card isn't a downloadable file; mark it as catalog.
      const direct=looksFile || /download|\.xml/i.test(url);
      let name=text;
      if(!name || name.length>180) name=nameFromUrl(url);
      // Strip common UI noise from card text.
      name=name.replace(/\b(add|buy|download|preview|open|in store)\b/gi,"").replace(/\s+/g," ").trim();
      if(name.length<3)name=nameFromUrl(url);
      const key=(direct?url:r.source+"|"+name.toLowerCase()).slice(0,500);
      if(!map.has(key)){
        map.set(key,{
          url,
          name:name.slice(0,180),
          type:direct?"XML":"Catalog",
          category:classify(text,url),
          source:r.source,
          downloadable:direct
        });
      }else if(direct && !map.get(key).downloadable){
        map.get(key).url=url;map.get(key).type="XML";map.get(key).downloadable=true;
      }
    }
    const items=[...map.values()].slice(0,500);
    return {
      ok:true,requestedUrl:target,finalUrl:page.url(),pagesScanned:visited.size,
      count:items.length,items,
      note:items.length
        ?"Rendered catalog/network candidates discovered. XML files are marked downloadable when a public direct file URL was found."
        :"No public bot catalog or XML/download candidates were discovered. The site's bot data may be behind authentication, protected APIs, or an interaction that requires authorized access."
    };
  }finally{await context.close();await browser.close();}
}
async function handleScan(req,res){
  let body="";
  req.on("data",c=>{body+=c;if(body.length>20000)req.destroy()});
  req.on("end",async()=>{
    try{
      const data=JSON.parse(body||"{}");
      const key=cleanUrl(data.url);
      if(jobs.has(key)) return json(res,200,{ok:true,job:jobs.get(key),reused:true});
      const job={id:Math.random().toString(36).slice(2),status:"running",startedAt:Date.now()};
      jobs.set(key,job);
      try{
        const result=await scanSite(key);
        job.status="complete"; job.result=result; job.finishedAt=Date.now();
        json(res,200,result);
      }catch(e){
        job.status="failed"; job.error=e.message; job.finishedAt=Date.now();
        json(res,500,{ok:false,error:e.message});
      }finally{
        setTimeout(()=>jobs.delete(key),10*60*1000);
      }
    }catch(e){json(res,400,{ok:false,error:e.message})}
  });
}
function safeFile(p){
  const decoded=decodeURIComponent(p.split("?")[0]||"/");
  const clean=path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const file=path.join(PUBLIC,clean==="/"?"index.html":clean);
  return file.startsWith(PUBLIC)?file:null;
}
const server=http.createServer((req,res)=>{
  if(req.method==="OPTIONS") return send(res,204,"","text/plain; charset=utf-8",{"Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type"});
  if(req.method==="GET" && req.url==="/health") return json(res,200,{ok:true,service:"deriv-bot-scanner-playwright"});
  if(req.method==="POST" && req.url==="/api/scan") return handleScan(req,res);
  if(req.method==="GET"){
    const file=safeFile(req.url||"/");
    if(!file) return send(res,403,"Forbidden");
    let actual=file;
    if(!fs.existsSync(actual)||fs.statSync(actual).isDirectory()) actual=path.join(PUBLIC,"index.html");
    const ext=path.extname(actual).toLowerCase();
    const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".png":"image/png",".jpg":"image/jpeg"};
    return send(res,200,fs.readFileSync(actual),types[ext]||"application/octet-stream");
  }
  send(res,405,"Method not allowed");
});
server.listen(PORT,"0.0.0.0",()=>console.log(`Scanner listening on ${PORT}`));
