const fs=require('node:fs'),path=require('node:path'),P=require('./planes.js');
function write(p,s){p=path.join(__dirname,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s.trimEnd()+'\n');}
for(const kind of P.KINDS){
  const palette=P.DEFAULTS[kind];
  write(`assets/${kind}/master.svg`,P.svg(kind,{palette}));
  for(const other of Object.keys(P.PALETTES))if(other!==palette)write(`assets/${kind}/master-${other}.svg`,P.svg(kind,{palette:other}));
  for(const theme of ['dark','light']){
    write(`assets/${kind}/app-icon-${theme}.svg`,P.svg(kind,{palette,theme,tile:true}));
    write(`assets/${kind}/mono-${theme}.svg`,P.svg(kind,{palette,theme,mono:true}));
    for(const size of [16,20,24,32])write(`assets/${kind}/status-${size}-${theme}.svg`,P.micro(kind,{palette,size,theme}));
  }
  write(`assets/${kind}/gathered.svg`,P.svg(kind,{palette,phase:'compact',tile:true}));
  write(`assets/${kind}/resting.svg`,P.svg(kind,{palette,phase:'expanded',tile:true}));
  write(`assets/${kind}/working-static.svg`,P.svg(kind,{palette,state:'working'}));
}
const kindOptions=P.KINDS.map((k,i)=>`<option value="${k}"${k==='fan'?' selected':''}>0${i+1} / ${P.NAMES[k]}</option>`).join('');
const colorOptions=Object.entries(P.PALETTES).map(([k,p])=>`<option value="${k}"${k==='lagoon'?' selected':''}>${p.name}</option>`).join('');
let html=fs.readFileSync(path.join(__dirname,'preview.template.html'),'utf8');
html=html.replace('<!--REFERENCE-->',P.svg('original',{palette:'blue',tile:true,size:310,state:'working'}))
  .replace('<!--CANDIDATE-->',P.svg('fan',{palette:'lagoon',tile:true,size:310,state:'working'}))
  .replace('<!--FORM_OPTIONS-->',kindOptions).replace('<!--COLOR_OPTIONS-->',colorOptions)
  .replace('<!--FORM_CARDS-->',P.KINDS.map((kind,i)=>{const palette=P.DEFAULTS[kind];return `<article><p class="eyebrow">0${i+1} / ${i===0?'Selected reference':'Structural remix'}</p><div class="still">${P.svg(kind,{palette,tile:true,size:220})}</div><h2>${P.NAMES[kind]} <span>/ ${P.PALETTES[palette].name}</span></h2><p>${P.NOTES[kind]}</p><div class="sizes">${[16,20,24,32].map(size=>`<div>${P.micro(kind,{palette,size})}<span>${size}px</span></div>`).join('')}</div><button type="button" class="form-pick" data-kind="${kind}" data-palette="${palette}">Try this combination</button></article>`;}).join(''))
  .replace('<!--PALETTE_CARDS-->',Object.entries(P.PALETTES).map(([palette,p])=>`<article><div class="palette-art">${P.svg('original',{palette,tile:true,size:160})}</div><h3>${p.name}</h3><div class="chips">${p.base.map(c=>`<span style="background:${c}"></span>`).join('')}<span style="background:${p.ice}"></span></div><button type="button" class="palette-pick" data-palette="${palette}" aria-pressed="${palette==='lagoon'}">Apply ${p.name}</button></article>`).join(''))
  .replace('/*MODEL*/',fs.readFileSync(path.join(__dirname,'planes.js'),'utf8'))
  .replace('/*PREVIEW*/',fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'));
write('index.html',html);console.log('Built six forms × six palettes, 126 SVGs, and an independent form/palette comparison.');
