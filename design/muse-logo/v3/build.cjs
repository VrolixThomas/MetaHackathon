/* Writes only v3. Node standard library, no dependencies or network. */
const fs = require('node:fs');
const path = require('node:path');
const E = require('./energy.js');
const root = __dirname;
function write(name, body) {
  const dest = path.join(root, name);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body.trimEnd() + '\n');
}
for (const kind of E.KINDS) {
  const base = `assets/${kind}`;
  write(`${base}/master.svg`, E.svg(kind));
  write(`${base}/app-icon-dark.svg`, E.svg(kind, { tile: true }));
  write(`${base}/app-icon-light.svg`, E.svg(kind, { tile: true, theme: 'light' }));
  for (const theme of ['dark', 'light']) {
    write(`${base}/mono-${theme}.svg`, E.svg(kind, { theme, mono: true, crisp: true }));
    for (const size of [16, 20, 24, 32]) write(`${base}/status-${size}-${theme}.svg`, E.micro(kind, { size, theme }));
  }
  for (const phase of ['compact', 'expanded']) write(`${base}/${phase}.svg`, E.svg(kind, { phase, tile: true }));
  for (const state of E.STATES) write(`${base}/reduced/${state}.svg`, E.svg(kind, { state }));
}
const copy = {
  gather: ['01 / Recommended', 'Gather', 'An uneven constellation held by one steady light. Depth and weight concentrate toward the core; the field gathers, opens and settles.', 'Closest to the reference’s warm, luminous depth. Strongest quiet app icon.'],
  orbit: ['02 / Close alternative', 'Broken orbit', 'Short tangential fragments form an interrupted field. They contract radially around the same stable core, without revolving.', 'More ordered and technical; the larger gaps keep the composition open.'],
  signal: ['03 / Close alternative', 'Signal field', 'Short radial forms collect attention inward and release it outward. Uneven lengths and spacing avoid a uniform sunburst.', 'More directional and assertive; a slightly sharper sense of activity.']
};
const cards = E.KINDS.map(kind => `<article class="card">
  <div class="kicker">${copy[kind][0]}</div>
  <div class="hero" data-kind="${kind}">${E.svg(kind, { tile: true, state: 'working', size: 284 })}</div>
  <div class="caption"><span class="live-label">Working · motion simulation</span><span>3.2s</span></div>
  <h2>${copy[kind][1]}</h2><p>${copy[kind][2]}</p><p class="tradeoff">${copy[kind][3]}</p>
  <div class="micro-row"><span class="micro-label">Actual px</span>${[16,20,24,32].map(size => `<div>${E.micro(kind,{size})}<span>${size}</span></div>`).join('')}</div>
  <div class="treatments"><div class="light">${E.svg(kind,{size:64,mono:true,theme:'light'})}<span>One color / light</span></div><div>${E.svg(kind,{size:64,mono:true})}<span>One color / dark</span></div><div class="light">${E.svg(kind,{size:64,theme:'light',tile:true})}<span>Light app icon</span></div></div>
  <div class="status-row">${E.micro(kind)}<span>Working</span><span class="muted">Design simulation</span></div>
</article>`).join('');
const keyframes = E.KINDS.map(kind => `<div class="keyframe-row"><h3>${E.NAMES[kind]}</h3>${['expanded','compact','expanded'].map((phase,i) => `<div>${E.svg(kind,{phase,tile:true,size:110})}<span>${['Open / 0.00s','Gathered / 1.50s','Open + settle / 3.20s'][i]}</span></div>`).join('')}</div>`).join('');
const staticMatrix = E.KINDS.map(kind => `<div class="state-row"><h3>${E.NAMES[kind]}</h3>${E.STATES.map(state => `<div>${E.svg(kind,{state,size:64,crisp:true})}<span>${E.LABELS[state]}</span></div>`).join('')}</div>`).join('');
let html = fs.readFileSync(path.join(root,'preview.template.html'),'utf8');
html = html.replace('<!--CARDS-->', cards).replace('<!--KEYFRAMES-->', keyframes).replace('<!--STATES-->', staticMatrix)
  .replace('/*ENERGY*/', fs.readFileSync(path.join(root,'energy.js'),'utf8'))
  .replace('/*PREVIEW*/', fs.readFileSync(path.join(root,'preview.js'),'utf8'))
  .replace('REFERENCE_DATA', 'data:image/png;base64,' + fs.readFileSync(path.join(root,'reference/superiorswarm-user-reference.png')).toString('base64'));
write('index.html', html);
console.log('Built 69 editable SVGs and one self-contained HTML preview inside v3.');
