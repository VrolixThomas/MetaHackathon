/* Non-browser checks. Does not launch a browser, server, app, or provider. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const C=require('./companion.js');
const root=__dirname;
let checks=0,poses=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
const same=(a,b,message)=>{assert.deepEqual(a,b,message);checks++;};
const different=(a,b,message)=>{assert.notDeepEqual(a,b,message);checks++;};

for(const kind of C.KINDS){
  for(const state of C.STATES){
    const fixed=C.pose(kind,state,0,0,false);
    same(fixed,C.pose(kind,state,37,1,false),`${kind}/${state}: reduced pose ignores time and amplitude`);
    for(let n=0;n<=80;n++)for(const amp of [0,.5,1]){
      const p=C.pose(kind,state,n/10,amp,true);poses++;
      check(Object.values(p).every(Number.isFinite),`${kind}/${state}: finite pose`);
      check(p.blink>=.07&&p.blink<=1&&p.sx>0&&p.sy>0,'No inverted scale or invalid blink');
      const attrs=JSON.stringify(C.attributes(kind,p));
      check(!/NaN|Infinity|undefined/.test(attrs),'Finite SVG attributes');
      if(kind==='firefly')same([p.x,p.y,p.tilt,p.sx,p.sy],[0,0,0,1,1],'Firefly core stays fixed');
    }
  }
  different(C.pose(kind,'listening',0,0),C.pose(kind,'listening',0,1),`${kind}: listening reacts to amplitude`);
  different(C.pose(kind,'speaking',0,0),C.pose(kind,'speaking',0,1),`${kind}: speaking reacts to amplitude`);
  same(C.pose(kind,'thinking',.4,0),C.pose(kind,'thinking',.4,1),`${kind}: working ignores voice amplitude`);
  same(C.pose(kind,'error',0),C.pose(kind,'error',9),`${kind}: error holds still`);
  same(C.pose(kind,'offline',0),C.pose(kind,'offline',9),`${kind}: offline holds still`);
  same(C.pose(kind,'success',2),C.pose(kind,'success',9),`${kind}: success settles`);
}
different(C.attributes('pocket',C.pose('pocket','thinking',.38)).rig,C.attributes('pocket',C.pose('pocket','thinking',.86)).rig,'Pocket visibly squishes then hops');
different(C.attributes('firefly',C.pose('firefly','thinking',.4)).wingLeft,C.attributes('firefly',C.pose('firefly','thinking',1.2)).wingLeft,'Firefly opens and closes wings');
different(C.attributes('octopus',C.pose('octopus','thinking',0)).arm0,C.attributes('octopus',C.pose('octopus','thinking',1.2)).arm0,'Octopus gathers and offers with arms');
same(C.clamp(-1),0,'Clamp lower bound');same(C.clamp(2),1,'Clamp upper bound');same(C.clamp(NaN),0,'NaN amplitude fails to silence');
assert.throws(()=>C.pose('unknown'));assert.throws(()=>C.pose('pocket','unknown'));checks+=2;

// Exercise the actual controller against a small attribute/event adapter.
// This verifies its lifecycle and math, not browser DOM behavior or rendering.
function eventTarget(){const listeners=new Map();return{listeners,addEventListener(k,f){if(!listeners.has(k))listeners.set(k,new Set());listeners.get(k).add(f);},removeEventListener(k,f){listeners.get(k)?.delete(f);},emit(k){for(const f of listeners.get(k)||[])f();}};}
let queue=new Map(),seq=0;
const mq=Object.assign(eventTarget(),{matches:false});
const doc=Object.assign(eventTarget(),{hidden:false});
const context={module:{exports:{}},matchMedia:()=>mq,requestAnimationFrame:f=>{queue.set(++seq,f);return seq;},cancelAnimationFrame:id=>queue.delete(id)};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'companion.js'),'utf8'),context);
const BrowserC=context.module.exports;
function fakeRoot(kind){
  const parts=new Map(),attrs=new Map();
  return {dataset:{kind},ownerDocument:doc,attrs,
    set innerHTML(markup){for(const m of markup.matchAll(/data-part="([^"]+)"/g))parts.set(m[1],{dataset:{part:m[1]},attrs:new Map(),setAttribute(k,v){this.attrs.set(k,String(v));}});},
    querySelectorAll(){return [...parts.values()];},setAttribute(k,v){attrs.set(k,String(v));},removeAttribute(k){attrs.delete(k);},parts};
}
const step=now=>{const pending=[...queue.values()];queue.clear();pending.forEach(f=>f(now));};
const svg=fakeRoot('pocket');
const controller=new BrowserC.Controller(svg,{state:'thinking'});
check(queue.size===1,'Active working controller schedules one frame');
for(let n=0;n<15;n++)step(n*20);
const before=svg.parts.get('rig').attrs.get('transform');
for(let n=15;n<40;n++)step(n*20);
different(svg.parts.get('rig').attrs.get('transform'),before,'Controller applies actual changing transforms');
controller.setState('speaking');controller.setAmplitude(1);for(let n=0;n<12;n++)step(n*20);
check(controller.level>.9&&controller.level<1,'65ms attack approaches normalized amplitude');
controller.setAmplitude(0);for(let n=12;n<24;n++)step(n*20);
check(controller.level>0&&controller.level<.5,'220ms release smooths envelope');
controller.setReducedMotion(true);check(queue.size===0,'Manual reduction cancels animation');
const frozen=svg.parts.get('rig').attrs.get('transform');controller.setAmplitude(1);
same(svg.parts.get('rig').attrs.get('transform'),frozen,'Static mode ignores amplitude');
controller.setReducedMotion(false);check(queue.size===1,'Motion resumes after manual reduction');
mq.matches=true;mq.emit('change');check(queue.size===0,'OS reduction overrides enabled animation');
controller.setReducedMotion(false);check(queue.size===0,'Manual toggle cannot defeat OS reduction');
mq.matches=false;mq.emit('change');check(queue.size===1,'OS preference change resumes movement');
doc.hidden=true;doc.emit('visibilitychange');check(queue.size===0,'Hidden document cancels frames');
doc.hidden=false;doc.emit('visibilitychange');check(queue.size===1,'Visible document resumes with no duplicate frame');
controller.setPaused(true);check(queue.size===0,'Pause cancels frames');controller.setPaused(false);
controller.setState('error');step(0);check(queue.size===0,'Held error needs no scheduled loop');
controller.setState('success');for(let n=0;n<80;n++)step(n*20);check(queue.size===0,'Success stops scheduling after celebration');
check(svg.attrs.get('aria-label')==='Companion: pocket, Success','Accessible label follows semantic state');
controller.destroy();controller.destroy();check(queue.size===0,'Destroy is idempotent and cancels frames');
check([...mq.listeners.values(),...doc.listeners.values()].every(s=>s.size===0),'Destroy releases event listeners');
controller.setAmplitude(.7);check(queue.size===0,'Destroyed controller cannot resume');

const html=fs.readFileSync(path.join(root,'index.html'),'utf8');
check(!/__COMPONENT|__CARDS|__MATRIX|__PREVIEW/.test(html),'No unresolved build placeholders');
check(!/<(?:script|link)[^>]+(?:src|href)=/i.test(html),'HTML has no external code/style imports');
check(!/(?:fetch\(|XMLHttpRequest|WebSocket|AudioContext|getUserMedia|navigator\.mediaDevices)/.test(html),'No network or media API');
check(!/file:\/\/|localhost|127\.0\.0\.1/.test(html),'No navigation workaround or local server target');
check(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"),'CSP blocks connection and media sources');
check((html.match(/class="direction /g)||[]).length===3,'All three side-by-side directions embedded');
check((html.match(/<option value=/g)||[]).length===8,'All eight simulated states offered');
check(html.includes('selected>Thinking / working'),'Hero starts working');
check(!/wordmark|monogram/i.test(fs.readFileSync(path.join(root,'assets/directions.json'),'utf8')),'No name-dependent design data');

const report={result:'PASS',checks,sampled_poses:poses,scope:'Pure geometry + actual controller with attribute/event adapter + HTML source checks; no browser',limits:['Does not verify browser layout, DOM semantics, CSS SVG animation playback, or physical devices.','Manual opening of index.html remains the interactive visual review.']};
fs.writeFileSync(path.join(root,'validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
