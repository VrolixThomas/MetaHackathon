/* Builds only this blue revision. No packages, network or product changes. */
const fs=require('node:fs'),path=require('node:path');
const B=require('./current.js');
const write=(p,s)=>{const file=path.join(__dirname,p);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,s.trimEnd()+'\n');};
for(const kind of B.KINDS){
  write(`assets/${kind}/master.svg`,B.svg(kind,{state:'idle'}));
  write(`assets/${kind}/app-icon-dark.svg`,B.svg(kind,{tile:true,state:'idle'}));
  write(`assets/${kind}/app-icon-light.svg`,B.svg(kind,{tile:true,theme:'light',state:'idle'}));
  for(const theme of ['dark','light']){
    write(`assets/${kind}/mono-${theme}.svg`,B.svg(kind,{theme,mono:true,state:'idle'}));
    for(const size of [16,20,24,32])write(`assets/${kind}/status-${size}-${theme}.svg`,B.micro(kind,{size,theme}));
  }
  for(const phase of ['compact','expanded'])write(`assets/${kind}/${phase}.svg`,B.svg(kind,{phase,tile:true}));
  for(const state of ['idle','working','listening','speaking','offline'])write(`assets/${kind}/reduced/${state}.svg`,B.svg(kind,{state}));
}
let html=fs.readFileSync(path.join(__dirname,'preview.template.html'),'utf8');
html=html.replace('<!--HERO-->',B.svg('confluence',{tile:true,state:'working',size:420}))
  .replace('<!--VARIANTS-->',B.KINDS.map((kind,i)=>`<article><div class="variant-icon">${B.svg(kind,{tile:true,state:'idle',size:168})}</div><div class="variant-copy"><p class="eyebrow">${i===0?'01 / Recommended':`0${i+1} / Close variation`}</p><h3>${B.NAMES[kind]}</h3><p>${['Two breaks per current preserve continuity and a clear directional silhouette.','Extra interruptions make the same light currents more particulate.','Longer tail segments give the same structure a quieter, more fluid cadence.'][i]}</p></div></article>`).join(''))
  .replace('<!--SIZES-->',[16,20,24,32].map(size=>`<div>${B.micro('confluence',{size})}<span>${size}px</span></div>`).join(''))
  .replace('<!--LIGHT-->',B.svg('confluence',{size:96,theme:'light',tile:true,state:'idle'}))
  .replace('<!--MONO-->',B.svg('confluence',{size:96,mono:true,state:'idle'}))
  .replace('<!--POSES-->',['expanded','compact','expanded'].map((phase,i)=>`<div>${B.svg('confluence',{tile:true,phase,size:160})}<span>${['Open / 0.00s','Gathered / 1.33s','Settled / 3.00s'][i]}</span></div>`).join(''))
  .replace('/*MODEL*/',fs.readFileSync(path.join(__dirname,'current.js'),'utf8'))
  .replace('/*CONTROLS*/',fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'));
write('index.html',html);
console.log('Built blue revision: 60 editable SVGs + self-contained HTML.');
