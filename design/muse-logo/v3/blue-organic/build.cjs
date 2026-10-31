const fs=require('node:fs'),path=require('node:path'),F=require('./field.js');
function write(p,s){p=path.join(__dirname,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s.trimEnd()+'\n');}
for(const kind of F.KINDS){
  write(`assets/${kind}/master.svg`,F.svg(kind));
  for(const theme of ['dark','light']){
    write(`assets/${kind}/app-icon-${theme}.svg`,F.svg(kind,{theme,tile:true}));
    write(`assets/${kind}/mono-${theme}.svg`,F.svg(kind,{theme,mono:true}));
    for(const size of [16,20,24,32])write(`assets/${kind}/status-${size}-${theme}.svg`,F.micro({size,theme}));
  }
  for(const phase of ['compact','expanded'])write(`assets/${kind}/${phase}.svg`,F.svg(kind,{phase,tile:true}));
  for(const state of ['idle','working','listening','speaking','offline'])write(`assets/${kind}/reduced/${state}.svg`,F.svg(kind,{state}));
}
let html=fs.readFileSync(path.join(__dirname,'preview.template.html'),'utf8');
html=html.replace('<!--HERO-->',F.svg('bloom',{tile:true,size:420,state:'working'}))
  .replace('<!--VARIANTS-->',F.KINDS.map((kind,i)=>`<article>${F.svg(kind,{tile:true,size:190})}<h3>0${i+1} / ${F.NAMES[kind]}</h3><p>${['Recommended balance of body and opening.','A larger opening; lighter and more spacious.','A smaller opening; denser and more tactile.'][i]}</p></article>`).join(''))
  .replace('<!--SIZES-->',[16,20,24,32].map(size=>`<div>${F.micro({size})}<span>${size}px</span></div>`).join(''))
  .replace('<!--MONO-->',F.svg('bloom',{size:100,mono:true,theme:'light'}))
  .replace('<!--POSES-->',['expanded','compact','expanded'].map((phase,i)=>`<div>${F.svg('bloom',{tile:true,size:170,phase})}<span>${['Open / 0.00s','Gathered / 1.40s','Settled / 3.20s'][i]}</span></div>`).join(''))
  .replace('/*MODEL*/',fs.readFileSync(path.join(__dirname,'field.js'),'utf8'))
  .replace('/*PREVIEW*/',fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'));
write('index.html',html);console.log('Built 60 editable SVGs and standalone organic-blue preview.');
