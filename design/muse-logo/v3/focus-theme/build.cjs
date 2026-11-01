const fs=require('node:fs'),path=require('node:path'),F=require('./focus.js');
function write(p,s){p=path.join(__dirname,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s.trimEnd()+'\n');}
for(const kind of F.KINDS){
  write(`assets/${kind}/master.svg`,F.svg(kind));
  for(const palette of ['lagoon','pearl'])write(`assets/${kind}/master-${palette}.svg`,F.svg(kind,{palette}));
  for(const theme of ['dark','light']){
    write(`assets/${kind}/app-icon-${theme}.svg`,F.svg(kind,{tile:true,theme}));
    write(`assets/${kind}/mono-${theme}.svg`,F.svg(kind,{theme,mono:true}));
    for(const size of [16,20,24,32])write(`assets/${kind}/status-${size}-${theme}.svg`,F.micro(kind,{size,theme}));
  }
  for(const [name,transition] of [['held',0],['handoff-out',.25],['handoff-middle',.5],['handoff-in',.75]])write(`assets/${kind}/${name}.svg`,F.svg(kind,{transition,tile:true}));
}
let html=fs.readFileSync(path.join(__dirname,'preview.template.html'),'utf8');
html=html.replace('<!--HERO-->',F.svg('plane',{size:410,tile:true,motion:true}))
  .replace('<!--CARDS-->',F.KINDS.map((kind,i)=>`<article><p class="eyebrow">0${i+1} / ${i===0?'Recommended':'Close alternative'}</p><div class="still">${F.svg(kind,{tile:true,size:230})}</div><h3>${F.NAMES[kind]}</h3><p>${F.NOTES[kind]}</p><div class="sizes">${[16,20,24,32].map(size=>`<div>${F.micro(kind,{size})}<span>${size}px</span></div>`).join('')}</div><button type="button" class="layout-pick" data-kind="${kind}">Inspect ${F.NAMES[kind]}</button></article>`).join(''))
  .replace('<!--KEYFRAMES-->',[0,.25,.5,.75,1].map((transition,i)=>`<div>${F.svg('plane',{transition,tile:true,size:128})}<span>${['Hold item 1','Let it recede','Handoff','Next comes forward','Hold item 2'][i]}</span></div>`).join(''))
  .replace('/*MODEL*/',fs.readFileSync(path.join(__dirname,'focus.js'),'utf8'))
  .replace('/*PREVIEW*/',fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'));
write('index.html',html);console.log('Built 57 editable SVGs and an offline focus-handoff demo.');
