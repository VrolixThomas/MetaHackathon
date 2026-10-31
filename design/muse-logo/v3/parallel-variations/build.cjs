const fs=require('node:fs'),path=require('node:path'),P=require('./parallel.js');
function write(p,s){p=path.join(__dirname,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s.trimEnd()+'\n');}
for(const kind of P.KINDS){
  write(`assets/${kind}/master.svg`,P.svg(kind));
  for(const theme of ['dark','light']){
    write(`assets/${kind}/app-icon-${theme}.svg`,P.svg(kind,{tile:true,theme}));
    write(`assets/${kind}/mono-${theme}.svg`,P.svg(kind,{mono:true,theme}));
    for(const size of [16,20,24,32])write(`assets/${kind}/status-${size}-${theme}.svg`,P.micro(kind,{size,theme}));
  }
  write(`assets/${kind}/gathered.svg`,P.svg(kind,{phase:'compact',tile:true}));
  write(`assets/${kind}/resting.svg`,P.svg(kind,{phase:'expanded',tile:true}));
  write(`assets/${kind}/working-static.svg`,P.svg(kind,{state:'working'}));
}
let html=fs.readFileSync(path.join(__dirname,'preview.template.html'),'utf8');
html=html.replace('<!--REFERENCE-->',P.svg('original',{tile:true,size:310,state:'working'}))
  .replace('<!--CANDIDATE-->',P.svg('compact',{tile:true,size:310,state:'working'}))
  .replace('<!--CARDS-->',P.KINDS.map((kind,i)=>`<article><p class="eyebrow">0${i+1} / ${i===0?'Approved reference':'Variation'}</p><div class="still">${P.svg(kind,{tile:true,size:220})}</div><h2>${P.NAMES[kind]}</h2><p>${P.NOTES[kind]}</p><div class="sizes">${[16,20,24,32].map(size=>`<div>${P.micro(kind,{size})}<span>${size}px</span></div>`).join('')}</div><button type="button" class="variation-pick" data-kind="${kind}">Compare ${P.NAMES[kind]}</button></article>`).join(''))
  .replace('/*MODEL*/',fs.readFileSync(path.join(__dirname,'parallel.js'),'utf8'))
  .replace('/*PREVIEW*/',fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'));
write('index.html',html);console.log('Built six Parallel options, 96 editable SVGs and an offline comparison preview.');
