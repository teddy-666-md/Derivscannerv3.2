const $=s=>document.querySelector(s), state={items:[],mode:"all"};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
function status(t,good=false){$("#status").textContent=t;$("#status").style.color=good?"#73e4a4":"#94a2b8"}
function render(){
 const q=$("#filter").value.trim().toLowerCase();
 const arr=state.items.filter(x=>(state.mode==="all"||x.category===state.mode)&&(!q||x.name.toLowerCase().includes(q)||x.url.toLowerCase().includes(q)));
 $("#results").innerHTML=arr.length?arr.map((x)=>{const i=state.items.indexOf(x);return `<article class="bot"><input type="checkbox" class="pick" data-i="${i}"><div><div class="name">${esc(x.name)} <span class="tag">${esc(x.category)}</span></div><div class="meta">${esc(x.source)} · ${esc(x.url)}</div></div><div class="actions">${x.downloadable?`<button class="preview" data-i="${i}">PREVIEW</button><a href="${esc(x.url)}" target="_blank" rel="noopener">OPEN</a>`:`<a href="${esc(x.url)}" target="_blank" rel="noopener">SOURCE</a>`}</div></article>`}).join(""):'<div class="empty">No matching bots.</div>';
 document.querySelectorAll(".preview").forEach(b=>b.onclick=()=>preview(+b.dataset.i));
}
async function scan(){
 const url=$("#url").value.trim(); if(!url)return status("Enter a website URL.");
 $("#scan").disabled=true;$("#scan").textContent="EXTRACTING...";status("Opening the site with a real browser and inspecting rendered content...");
 $("#results").innerHTML="";$("#stats").classList.add("hidden");$("#controls").classList.add("hidden");
 try{
  const r=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url})});
  const d=await r.json(); if(!d.ok)throw Error(d.error||"Extraction failed");
  state.items=d.items||[];
  const sp=state.items.filter(x=>x.category==="Special").length, st=state.items.filter(x=>x.category==="Standard").length;
  $("#total").textContent=state.items.length;$("#special").textContent=sp;$("#standard").textContent=st;$("#pages").textContent=d.pagesScanned||0;
  $("#stats").classList.remove("hidden");$("#controls").classList.toggle("hidden",!state.items.length);render();
  status(`${state.items.length} candidate${state.items.length===1?"":"s"} found. ${d.note}`,!!state.items.length);
 }catch(e){status("Extraction failed: "+e.message);$("#results").innerHTML='<div class="empty">No results. The target may require authentication or block automated/public access.</div>'}
 finally{$("#scan").disabled=false;$("#scan").textContent="EXTRACT BOTS"}
}
async function preview(i){
 const x=state.items[i];$("#mtitle").textContent=x.name;$("#preview").textContent="Loading...";$("#modal").classList.remove("hidden");
 try{const r=await fetch(x.url);const t=await r.text();$("#preview").textContent=t.slice(0,500000)}
 catch(e){$("#preview").textContent="This file cannot be previewed through the browser. Open the source URL directly."}
}
async function zipSelected(){
 const picks=[...document.querySelectorAll(".pick:checked")].map(e=>state.items[+e.dataset.i]);if(!picks.length)return status("Select bots first.");
 const z=new JSZip();status(`Building ZIP for ${picks.length} bot(s)...`);
 for(let i=0;i<picks.length;i++){const x=picks[i];try{const r=await fetch(x.url);if(!r.ok)throw Error("HTTP "+r.status);let n=(x.name||"bot").replace(/[^\w.-]+/g,"_");if(!/\.xml$/i.test(n))n+=".xml";z.file(n,await r.blob())}catch(e){z.file(`FAILED_${i}.txt`,`Could not download ${x.url}\n${e.message}`)}}
 const b=await z.generateAsync({type:"blob"}),a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="deriv-bots.zip";a.click();status("ZIP created.",true);
}
$("#scan").onclick=scan;$("#url").onkeydown=e=>e.key==="Enter"&&scan();$("#filter").oninput=render;
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));b.classList.add("active");state.mode=b.dataset.filter;render()});
$("#selectAll").onclick=()=>{document.querySelectorAll(".pick").forEach(x=>x.checked=true);zipSelected()};
$("#close").onclick=()=>$("#modal").classList.add("hidden");$("#modal").onclick=e=>e.target.id==="modal"&&$("#modal").classList.add("hidden");
$("#copy").onclick=async()=>{await navigator.clipboard.writeText($("#preview").textContent);status("XML copied.",true)};
