const fs=require('node:fs'),path=require('node:path'),S=require('./focus.js');
function write(p,s){p=path.join(__dirname,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s.trimEnd()+'\n');}
write('assets/master.svg',S.svg());
for(const theme of ['dark','light']){
  write(`assets/app-icon-${theme}.svg`,S.svg({theme,tile:true}));
  write(`assets/mono-${theme}.svg`,S.svg({theme,mono:true}));
  for(const size of [16,20,24,32])write(`assets/status-${size}-${theme}.svg`,S.micro({size,theme}));
}
for(const phase of ['compact','expanded'])write(`assets/${phase}.svg`,S.svg({phase,tile:true}));
for(const state of ['idle','working','listening','speaking','offline'])write(`assets/reduced/${state}.svg`,S.svg({state}));
let html=fs.readFileSync(path.join(__dirname,'preview.template.html'),'utf8');
html=html.replace('<!--HERO-->',S.svg({tile:true,state:'working',size:440}))
  .replace('<!--SIZES-->',[16,20,24,32].map(size=>`<div>${S.micro({size})}<span>${size}px</span></div>`).join(''))
  .replace('<!--MONO-->',S.svg({size:100,mono:true,theme:'light'}))
  .replace('<!--POSES-->',[0,1.4,3.2].map((time,i)=>`<div>${S.svg({state:'working',time,motion:true,tile:true,size:170})}<span>${['Independent threads','Context gathers','Space opens again'][i]}</span></div>`).join(''))
  .replace('/*MODEL*/',fs.readFileSync(path.join(__dirname,'focus.js'),'utf8'))
  .replace('/*PREVIEW*/',fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'));
write('index.html',html);console.log('Built 20 editable SVGs and self-contained shared-focus preview.');
