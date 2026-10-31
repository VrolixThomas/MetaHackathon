/* Geometry and actual preview event wiring, executed without a browser. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const B=require('./current.js');
const STATES=['idle','working','listening','speaking','offline'];
let samples=0,minPadding=Infinity;
const distance=p=>Math.hypot(p[0]-B.ANCHOR.x,p[1]-B.ANCHOR.y);
for(const kind of B.KINDS)for(const state of STATES)for(let i=0;i<=150;i++)for(const amplitude of [0,1]){
  const p=B.pose(kind,{state,time:i*.04,amplitude,motion:true});
  assert.deepEqual(p.core,B.CORE);
  for(const c of p.currents){
    assert.ok(c.width>0&&c.opacity>=0&&c.opacity<=1);
    for(const [x,y] of c.points){
      assert.ok(Number.isFinite(x)&&Number.isFinite(y));
      const pad=Math.min(x,y,256-x,256-y)-c.width/2;
      minPadding=Math.min(minPadding,pad);assert.ok(pad>15);
    }
  }
  for(const t of p.traces)for(const key of ['x1','y1','x2','y2','width','opacity'])assert.ok(Number.isFinite(t[key]));
  samples++;
}
const shrink=[];
for(const kind of B.KINDS){
  const open=B.pose(kind,{phase:'expanded'}),compact=B.pose(kind,{phase:'compact'});
  for(const [i,c] of compact.currents.entries()){
    assert.ok(c.width<open.currents[i].width);
    assert.ok(c.points.every((p,j)=>distance(p)<distance(open.currents[i].points[j])));
  }
  shrink.push({kind,outer_distance_ratio:Number((distance(compact.currents[0].points[0])/distance(open.currents[0].points[0])).toFixed(3))});
  assert.deepEqual(B.pose(kind,{motion:true,time:0}),B.pose(kind,{motion:true,time:3}));
  assert.deepEqual(B.pose(kind,{state:'speaking',motion:false,amplitude:0,time:0}),B.pose(kind,{state:'speaking',motion:false,amplitude:1,time:12}));
  const a=B.pose(kind,{state:'speaking',motion:true,amplitude:0}),b=B.pose(kind,{state:'speaking',motion:true,amplitude:1});
  assert.ok(distance(b.currents[0].points[0])>distance(a.currents[0].points[0]));
  const svg=B.svg(kind,{state:'idle'});
  assert.ok(svg.includes('data-core="true"')&&svg.includes('data-current="0-0"'));
  assert.ok(!/<circle\b/.test(svg),'A dot constellation has re-entered the composition');
}
assert.ok(B.gather(.1,'outer')>0&&B.gather(.1,'mid')===0&&B.gather(.1,'inner')===0);
assert.ok(B.gather(2.73,'outer')<0);

function n(attrs={}){return{attrs,dataset:{},listeners:{},checked:false,value:'',textContent:'',setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,fn){this.listeners[k]=fn;},fire(k){this.listeners[k]?.();}};}
const ids=['state','kind','pause','replay','reduce','amplitude','amplitude-value','synthetic','compact','expanded','hero','variant-title','choice-label','control-title','sim-label','announcement'];
const els=Object.fromEntries(ids.map(id=>[id,n()]));els.kind.value='confluence';els.state.value='working';els.amplitude.value='.5';
let activePaths,activeHalos,activeTraces;
function nodes(){
  const pose=B.pose(els.kind.value);
  activePaths=pose.currents.map(c=>{const p=n();p.dataset.current=c.id;return p;});
  activeHalos=pose.currents.map(c=>{const p=n();p.dataset.halo=c.id;const children=Array.from({length:36},()=>n());p.querySelectorAll=()=>children;return p;});
  activeTraces=pose.traces.map(c=>{const p=n();p.dataset.trace=c.id;return p;});
}
nodes();
Object.defineProperty(els.hero,'innerHTML',{set(value){assert.ok(value.includes('data-current'));nodes();}});
els.hero.querySelectorAll=q=>q==='[data-current]'?activePaths:q==='[data-halo]'?activeHalos:activeTraces;
const doc=n();doc.hidden=false;doc.getElementById=k=>els[k];
const pref=n();pref.matches=false;const win=n();win.matchMedia=()=>pref;
let id=0;const queue=new Map();
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'),{
  BlueCurrent:B,document:doc,window:win,requestAnimationFrame(fn){const i=++id;queue.set(i,fn);return i;},cancelAnimationFrame(i){queue.delete(i);}
});
const frame=t=>{const p=queue.entries().next().value;assert.ok(p,'Missing frame');queue.delete(p[0]);p[1](t);};
assert.equal(queue.size,1);const initial=activePaths[0].attrs.d;frame(0);for(let i=1;i<=28;i++)frame(i*40);
assert.notEqual(activePaths[0].attrs.d,initial,'Preview must update actual curve geometry');
assert.equal(activeHalos[0].querySelectorAll()[0].attrs.d,activePaths[0].attrs.d);
els.reduce.checked=true;els.reduce.fire('change');assert.equal(queue.size,0);
els.synthetic.checked=true;els.synthetic.fire('change');assert.equal(queue.size,0);
els.reduce.checked=false;pref.matches=true;pref.fire('change');assert.equal(queue.size,0);
pref.matches=false;pref.fire('change');assert.equal(queue.size,1);
doc.hidden=true;doc.fire('visibilitychange');assert.equal(queue.size,0);
doc.hidden=false;doc.fire('visibilitychange');assert.equal(queue.size,1);
els.compact.fire('click');assert.equal(queue.size,0);const gathered=activePaths[0].attrs.d;
els.expanded.fire('click');assert.notEqual(activePaths[0].attrs.d,gathered);assert.equal(queue.size,0);
els.replay.fire('click');assert.equal(queue.size,1);
for(const kind of B.KINDS){els.kind.value=kind;els.kind.fire('change');assert.ok(els['variant-title'].textContent.includes(B.NAMES[kind]));assert.equal(activePaths.length,B.pose(kind).currents.length);}
for(const state of STATES){els.state.value=state;els.state.fire('change');assert.ok(els.announcement.textContent.includes('Silent design simulation'));}
els.state.value='speaking';els.state.fire('change');frame(0);frame(40);
els.pause.fire('click');assert.equal(queue.size,0);
els.state.value='working';els.state.fire('change');assert.equal(queue.size,1);
win.fire('pagehide');assert.equal(queue.size,0);
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));
assert.ok(!/\b(?:fetch|XMLHttpRequest|getUserMedia|WebSocket|AudioContext)\s*\(/.test(html));
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));
assert.ok(!/<!--(?:HERO|VARIANTS|SIZES|LIGHT|MONO|POSES)-->|\/\*(?:MODEL|CONTROLS)\*\//.test(html));
const report={
  pose_samples:samples,core:'Exact fixed line (147,112) -> (165,91), width12',
  minimum_curve_control_point_padding:Number(minPadding.toFixed(2)),shrink,
  checks:['real curve contraction and stroke shrink','staggered onset','settle overshoot','exact 3s loop seam','simulated envelope breadth','reduced motion ignores time and amplitude','preview updates paths and corresponding halos','all composition/state bindings','pause, compact/open and replay','manual/system reduction','hidden-document and page-exit suspension','self-contained HTML without media/network APIs'],
  scope:'Non-browser geometry and preview attribute/event adapter. Browser layout, interaction, playback and accessibility are unverified.'
};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
