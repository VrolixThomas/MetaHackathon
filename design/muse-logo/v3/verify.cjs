/* Bounded non-browser motion and control probes. This is not browser acceptance. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('./energy.js');
let sampled = 0;
let minPadding = Infinity;
for (const kind of E.KINDS) for (const state of E.STATES) {
  for (let i = 0; i <= 160; i++) for (const amplitude of [0,1]) {
    const p = E.pose(kind, {state, time: i * .04, amplitude, motion: true});
    assert.deepEqual(p.core, {x:128,y:128,r:13.5});
    for (const q of p.particles) {
      for (const key of ['x','y','r','length','angle','opacity','scale']) assert.ok(Number.isFinite(q[key]), key);
      assert.ok(q.opacity >= 0 && q.opacity <= 1);
      const reach = q.r + q.length / 2;
      const padding = Math.min(q.x - reach, q.y - reach, 256 - q.x - reach, 256 - q.y - reach);
      minPadding = Math.min(minPadding, padding);
      assert.ok(padding > 5, `${kind}/${state}: insufficient crisp-shape padding ${padding}`);
    }
    sampled++;
  }
}
const radiusChecks = [];
for (const kind of E.KINDS) {
  const open = E.pose(kind, {phase:'expanded'});
  const compact = E.pose(kind, {phase:'compact'});
  for (const group of ['outer','mid','inner']) {
    const o = open.particles.filter(p=>p.group===group);
    const c = compact.particles.filter(p=>p.group===group);
    const ratios = o.map((p,i)=>Math.hypot(c[i].x-128,c[i].y-128)/Math.hypot(p.x-128,p.y-128));
    for (const r of ratios) assert.ok(Math.abs(r-E.MIN[group]) < .00001);
    assert.ok(c.every((p,i)=>p.r<o[i].r), 'Gathering must also shrink the particles');
    radiusChecks.push({kind,group,compact_radius_ratio:Number(ratios[0].toFixed(3))});
  }
  assert.deepEqual(E.pose(kind,{state:'working',motion:true,time:0}),E.pose(kind,{state:'working',motion:true,time:3.2}));
  const moving = E.pose(kind,{state:'working',motion:true,time:1.5});
  assert.ok(moving.particles.every((p,i)=>Math.hypot(p.x-128,p.y-128)<Math.hypot(open.particles[i].x-128,open.particles[i].y-128)));
  assert.deepEqual(E.pose(kind,{state:'speaking',amplitude:0,motion:false}),E.pose(kind,{state:'speaking',amplitude:1,motion:false}));
  const small = E.pose(kind,{state:'speaking',amplitude:0,motion:true});
  const large = E.pose(kind,{state:'speaking',amplitude:1,motion:true});
  assert.ok(large.particles.every((p,i)=>Math.hypot(p.x-128,p.y-128)>Math.hypot(small.particles[i].x-128,small.particles[i].y-128)));
}
assert.ok(E.contraction(.2,'outer')>0 && E.contraction(.2,'mid')===0 && E.contraction(.2,'inner')===0, 'Stagger must be real');
assert.ok(E.contraction(2.95,'outer')<0, 'Settle overshoot missing');

// Minimal attribute/event adapter: executes the actual preview source in a Node VM.
// It checks scheduling, event connections and vector updates, not layout or native DOM.
function node(attrs={}) {
  return {attrs, dataset:{}, checked:false, value:'',textContent:'',listeners:{},
    setAttribute(k,v){this.attrs[k]=String(v);},
    getAttribute(k){return this.attrs[k];},
    addEventListener(k,fn){this.listeners[k]=fn;},
    fire(k){this.listeners[k]?.();}
  };
}
const ids=['state','pause','replay','reduce','amplitude','amplitude-value','synthetic','compact','expanded','timeline','time-value','simulation-heading','announcement'];
const elements=Object.fromEntries(ids.map(k=>[k,node()]));
elements.state.value='working';elements.amplitude.value='.5';elements.timeline.value='0';
const labels=E.KINDS.map(()=>node());
const hosts=E.KINDS.map(kind=>{
  const particles=E.pose(kind).particles.map(p=>{
    const group=node();group.dataset.particle=String(p.id);group.firstElementChild=node();return group;
  });
  const halos=E.pose(kind).particles.filter(p=>p.group!=='outer').map(p=>{const n=node();n.dataset.halo=String(p.id);return n;});
  return {dataset:{kind},querySelectorAll(q){return q==='[data-particle]'?particles:q==='[data-halo]'?halos:[];},particles,halos};
});
const doc=node();doc.hidden=false;doc.getElementById=k=>elements[k];doc.querySelectorAll=q=>q==='.hero'?hosts:labels;
const pref=node();pref.matches=false;
const win=node();win.matchMedia=()=>pref;
let count=0;const scheduled=new Map();
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'),{
  Energy:E,document:doc,window:win,
  requestAnimationFrame(fn){const id=++count;scheduled.set(id,fn);return id;},
  cancelAnimationFrame(id){scheduled.delete(id);}
});
function frame(now){const pair=scheduled.entries().next().value;assert.ok(pair,'Expected scheduled frame');scheduled.delete(pair[0]);pair[1](now);}
assert.equal(scheduled.size,1,'Working must start immediately');
const initialX=hosts[0].particles[11].firstElementChild.attrs.cx;
frame(0);for(let i=1;i<=30;i++)frame(i*40);
assert.notEqual(hosts[0].particles[11].firstElementChild.attrs.cx,initialX,'Actual preview shapes must move inward');
assert.ok(hosts[0].halos[0].attrs.transform.includes('translate('),'Light must follow the shapes');
elements.reduce.checked=true;elements.reduce.fire('change');assert.equal(scheduled.size,0);
const fixed=hosts[0].particles[11].firstElementChild.attrs.cx;
elements.synthetic.checked=true;elements.synthetic.fire('change');assert.equal(scheduled.size,0);
assert.equal(hosts[0].particles[11].firstElementChild.attrs.cx,fixed);
elements.reduce.checked=false;pref.matches=true;pref.fire('change');assert.equal(scheduled.size,0,'System reduced preference must win');
pref.matches=false;pref.fire('change');assert.equal(scheduled.size,1);
doc.hidden=true;doc.fire('visibilitychange');assert.equal(scheduled.size,0);
doc.hidden=false;doc.fire('visibilitychange');assert.equal(scheduled.size,1);
elements.compact.fire('click');assert.equal(scheduled.size,0);assert.equal(elements.compact.attrs['aria-pressed'],'true');
const compactX=hosts[0].particles[11].firstElementChild.attrs.cx;
elements.expanded.fire('click');assert.notEqual(hosts[0].particles[11].firstElementChild.attrs.cx,compactX);
elements.replay.fire('click');assert.equal(scheduled.size,1);
elements.timeline.value='1.5';elements.timeline.fire('input');assert.equal(scheduled.size,0);assert.equal(elements.pause.attrs['aria-pressed'],'true');
assert.equal(elements['time-value'].textContent,'1.50s');
for(const state of E.STATES){elements.state.value=state;elements.state.fire('change');assert.ok(elements.announcement.textContent.includes(E.LABELS[state]));}
elements.state.value='speaking';elements.state.fire('change');frame(100);frame(140);
assert.ok(Number(elements['amplitude-value'].textContent)>=0);
elements.pause.fire('click');assert.equal(scheduled.size,0);
elements.state.value='working';elements.state.fire('change');assert.equal(scheduled.size,1);
win.fire('pagehide');assert.equal(scheduled.size,0,'Page exit must release frames');

const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
assert.ok(html.includes("connect-src 'none'") && html.includes("media-src 'none'"));
assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext|EventSource)\s*\(/.test(html));
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html),'External dependency found');
assert.ok(!/<!--(?:CARDS|STATES|KEYFRAMES)-->|\/\*(?:ENERGY|PREVIEW)\*\//.test(html));
const report={
  pose_samples:sampled, core:'128 / 128 / r13.5 in every sample',
  minimum_crisp_shape_padding:Number(minPadding.toFixed(2)), radius_checks:radiusChecks,
  motion_checks:['actual radius contraction and particle shrink','staggered onset','gentle settle overshoot','exact 3.2s seam','speaking breadth responds; reduced motion does not'],
  preview_adapter_checks:['immediate working loop','actual particle and halo attribute updates','manual and OS reduction','hidden-document suspension','compact/expanded controls','cycle scrub','all eight state bindings','synthetic envelope scheduling','pause and page-exit cancellation'],
  html_checks:['embedded code and artwork','no external dependencies','CSP blocks connections and media','no network or microphone APIs'],
  scope:'Node geometry and attribute/event adapter only. Does not prove browser DOM, layout, playback or accessibility.'
};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
