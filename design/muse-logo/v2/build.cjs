/* Rebuild only this directory. No browser, server, packages, or product files. */
const fs=require('node:fs');
const path=require('node:path');
const C=require('./companion.js');
const root=__dirname;
const write=(p,s)=>{const full=path.join(root,p);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,s.trimEnd()+'\n');};
const animatedStyles={
  pocket:`[data-part="rig"]{transform-origin:60px 91px;animation:pocket 2.4s ease-in-out infinite}[data-part="earLeft"]{transform-origin:39px 48px;animation:ear 2.4s ease-in-out infinite}[data-part="pupils"]{animation:gaze 4.8s ease-in-out infinite}@keyframes pocket{0%,100%{transform:rotate(-5deg)}16%{transform:scale(1.14,.83)}36%{transform:translateY(-9px) scale(.925,1.12)}70%{transform:rotate(5deg)}}@keyframes ear{0%,100%{transform:rotate(0)}16%{transform:rotate(30deg)}36%{transform:rotate(-17deg)}}@keyframes gaze{0%,100%{transform:translateX(-3px)}50%{transform:translateX(3px)}}`,
  firefly:`[data-part="wingLeft"]{transform-origin:54px 53px;animation:left 1.6s ease-in-out infinite}[data-part="wingRight"]{transform-origin:66px 53px;animation:right 1.6s ease-in-out infinite}[data-part="glow"]{animation:light 1.6s ease-in-out infinite}@keyframes left{0%,100%{transform:rotate(15deg)}50%{transform:rotate(-39deg)}}@keyframes right{0%,100%{transform:rotate(-15deg)}50%{transform:rotate(39deg)}}@keyframes light{0%,100%{opacity:.74}50%{opacity:1}}`,
  octopus:`[data-part="arm0"]{transform-origin:41px 70px;animation:a 2.4s ease-in-out infinite}[data-part="arm1"]{transform-origin:46px 78px;animation:a 2.4s -.12s ease-in-out infinite}[data-part="arm6"]{transform-origin:78px 77px;animation:b 2.4s -.24s ease-in-out infinite}[data-part="arm7"]{transform-origin:83px 69px;animation:b 2.4s -.36s ease-in-out infinite}[data-part="rig"]{transform-origin:60px 91px;animation:lean 2.4s ease-in-out infinite}@keyframes a{0%,100%{transform:rotate(36deg)}50%{transform:rotate(-28deg)}}@keyframes b{0%,100%{transform:rotate(-36deg)}50%{transform:rotate(28deg)}}@keyframes lean{0%,100%{transform:rotate(-4deg)}50%{transform:translateY(-2px) rotate(4deg)}}`
};
for(const kind of C.KINDS){
  write(`assets/${kind}/master.svg`,C.svg(kind));
  write(`assets/${kind}/micro-16.svg`,C.smallSVG(kind));
  for(const theme of ['light','dark']){
    write(`assets/${kind}/mono-${theme}.svg`,C.svg(kind,{theme,mono:true}));
    const bg=theme==='light'?'#FFFDF7':'#202A29';
    let tile=C.svg(kind,{theme,size:128}).replace('viewBox="0 0 120 120"','viewBox="0 0 128 128"');
    tile=tile.replace(/(<svg[^>]*>)/,`$1<rect width="128" height="128" rx="29" fill="${bg}"/><g transform="translate(9 9) scale(.9167)">`).replace('</svg>','</g></svg>');
    write(`assets/${kind}/app-tile-${theme}.svg`,tile);
    for(const state of C.STATES)write(`assets/${kind}/states/${state}-${theme}.svg`,C.svg(kind,{state,theme}));
  }
  const styles=animatedStyles[kind]+`[data-part="eyes"]{transform-origin:60px 61px;animation:blink 5.4s infinite}@keyframes blink{0%,84%,90%,100%{transform:scaleY(1)}87%{transform:scaleY(.08)}}@media(prefers-reduced-motion:reduce){*{animation:none!important}}`;
  let anim=C.svg(kind,{state:'thinking',motion:false,size:240});
  anim=anim.replace(/(<svg[^>]*>)/,`$1<style>${styles}</style>`);
  write(`assets/${kind}/working-animated.svg`,anim);
}

const descriptions={
  pocket:'A curious pocket creature that leans in to hear you and springs into action, making a voice engineering assistant feel approachable.',
  firefly:'A friendly firefly that opens its wings around a steady light, showing focused engineering work without losing its calm center.',
  octopus:'A soft eight-armed helper that gathers loose threads and opens them toward you, making parallel engineering work feel coordinated.'
};
write('assets/directions.json',JSON.stringify({title:'Identity study v2',directions:C.KINDS.map((kind,i)=>({id:kind,label:`0${i+1} Companion`,depiction:kind,explanation:descriptions[kind],color:C.COLORS[kind]}))},null,2));

const headings=['Pocket creature','Firefly','Octopus helper'];
let cards=C.KINDS.map((kind,i)=>`<article class="direction ${kind}">
  <div class="card-kicker"><span>0${i+1} / Companion</span><span class="tag">${i===0?'Recommended':i===1?'Steady & bright':'Gather & offer'}</span></div>
  <div class="hero-stage"><div class="live-companion">${C.svg(kind,{state:'thinking',decorative:true,size:240})}</div><div class="still-companion">${C.svg(kind,{state:'idle',decorative:true,size:76})}<span>Static identity</span></div></div>
  <div class="state-caption"><span class="status-pip"></span><span class="live-state">Thinking / working</span><span>simulation</span></div>
  <h2>${headings[i]}</h2><p class="one-sentence">${descriptions[kind]}</p>
  <p class="personality">${['Squish → peek → pop. Curious and slightly mischievous.','Close → open → settle. Precise, patient and alert.','Gather → sort → offer. Capable and generous.'][i]}</p>
  <div class="size-test"><span class="micro-caption">Actual CSS px</span>${[16,20,24,32].map(size=>`<div class="size-item">${size<=20?C.smallSVG(kind,{size}):C.svg(kind,{size,decorative:true})}<span>${size}</span></div>`).join('')}<div class="size-item">${C.svg(kind,{size:64,decorative:true})}<span>64</span></div></div>
  <div class="applications"><div class="application-light">${C.svg(kind,{size:48,mono:true,decorative:true})}<span>Mono / light</span></div><div class="application-dark">${C.svg(kind,{size:48,mono:true,theme:'dark',decorative:true})}<span>Mono / dark</span></div><div class="tile-wrap"><img width="56" height="56" alt="${headings[i]} app tile" src="data:image/svg+xml,${encodeURIComponent(fs.readFileSync(path.join(root,`assets/${kind}/app-tile-dark.svg`),'utf8'))}"><span>App tile</span></div></div>
  <div class="tiny-row">${C.smallSVG(kind,{size:16})}<span>Companion</span><span class="tiny-state">Working · simulated</span></div>
</article>`).join('');

const stateMatrix=C.KINDS.map((kind,i)=>`<div class="state-row"><h3>0${i+1}<br>${headings[i]}</h3>${C.STATES.map(state=>`<div>${C.svg(kind,{state,size:64,decorative:true})}<span>${C.LABELS[state]}</span></div>`).join('')}</div>`).join('');
let template=fs.readFileSync(path.join(root,'preview.template.html'),'utf8');
template=template.replace('/*__COMPONENT_CSS__*/',fs.readFileSync(path.join(root,'companion.css'),'utf8')).replace('<!--__CARDS__-->',cards).replace('<!--__MATRIX__-->',stateMatrix).replace('/*__COMPONENT_JS__*/',fs.readFileSync(path.join(root,'companion.js'),'utf8')).replace('/*__PREVIEW_JS__*/',fs.readFileSync(path.join(root,'preview.js'),'utf8'));
write('index.html',template);

// Non-browser rendering input: sampled from exactly the same JS geometry/motion model.
// PyMuPDF/Pillow consume this JSON without executing any browser surface.
const samples={};
for(const kind of C.KINDS){
  samples[kind]={hero:C.svg(kind,{state:'thinking',time:kind==='pocket'?.86:.6,motion:true,size:320}),
    micro:Object.fromEntries([16,20,24,32,64].map(size=>[size,size<=20?C.smallSVG(kind,{size}):C.svg(kind,{size})])),
    monoLight:C.svg(kind,{mono:true}),monoDark:C.svg(kind,{mono:true,theme:'dark'}),
    monoNeedsLight:C.svg(kind,{state:'needs-input',mono:true}),monoNeedsDark:C.svg(kind,{state:'needs-input',mono:true,theme:'dark'}),
    tileLight:fs.readFileSync(path.join(root,`assets/${kind}/app-tile-light.svg`),'utf8'),tileDark:fs.readFileSync(path.join(root,`assets/${kind}/app-tile-dark.svg`),'utf8'),
    states:Object.fromEntries(C.STATES.map(state=>[state,C.svg(kind,{state})])),
    darkStates:Object.fromEntries(C.STATES.map(state=>[state,C.svg(kind,{state,theme:'dark',mono:true})])),
    beats:[0,.45,.9,1.5].map(time=>C.svg(kind,{state:'thinking',time,motion:true})),
    frames:Array.from({length:60},(_,i)=>C.svg(kind,{state:'thinking',time:i/25,motion:true,size:180}))
  };
}
write('render-samples.json',JSON.stringify(samples));
console.log('Built 69 editable SVGs, self-contained HTML, motion samples, and direction data.');
