const fs=require('node:fs'),path=require('node:path'),M=require('./marks.js');
const write=(p,s)=>{p=path.join(__dirname,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s.trimEnd()+'\n');};
for(const kind of M.KINDS){
  write(`assets/${kind}/master.svg`,M.svg(kind));
  for(const theme of ['dark','light']){
    write(`assets/${kind}/app-icon-${theme}.svg`,M.svg(kind,{theme,tile:true}));
    write(`assets/${kind}/mono-${theme}.svg`,M.svg(kind,{theme,mono:true}));
    for(const size of [16,20,24,32])write(`assets/${kind}/status-${size}-${theme}.svg`,M.micro(kind,{size,theme}));
  }
  for(const phase of ['compact','expanded'])write(`assets/${kind}/${phase}.svg`,M.svg(kind,{phase,tile:true}));
  write(`assets/${kind}/working-static.svg`,M.svg(kind,{state:'working'}));
}
const descriptions={relay:'One intent, coordinated action. Two solid light fragments share a heading and draw into alignment.',synthesis:'Separate efforts become one coherent result. Two flat light surfaces share a brighter common region.',parallel:'Independent work continues alongside your foreground conversation. Separate surfaces share one orientation.'};
let html=fs.readFileSync(path.join(__dirname,'preview.template.html'),'utf8');
html=html.replace('<!--CARDS-->',M.KINDS.map((kind,i)=>`<article><p class="eyebrow">0${i+1} / Fresh direction</p><div class="still">${M.svg(kind,{tile:true,size:260})}</div><h2>${M.NAMES[kind]}</h2><p>${descriptions[kind]}</p><div class="sizes">${[16,20,24,32].map(size=>`<div>${M.micro(kind,{size})}<span>${size}px</span></div>`).join('')}</div></article>`).join(''))
  .replace('<!--HERO-->',M.svg('relay',{tile:true,size:330,state:'working'}))
  .replace('/*MODEL*/',fs.readFileSync(path.join(__dirname,'marks.js'),'utf8'))
  .replace('/*PREVIEW*/',fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'));
write('index.html',html);console.log('Built three fresh directions, 48 SVGs and self-contained preview.');
