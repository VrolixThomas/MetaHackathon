/* Focused geometry/reference and actual comparison-controller probes; no browser. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),P=require('./parallel.js');
const previous=require('../reset/marks.js');
let samples=0,minMargin=Infinity;
function bounds(pose){const xs=[],ys=[];for(const q of pose.parts){const a=q.d.match(/-?\d+(?:\.\d+)?/g).map(Number);assert.equal(a.length%2,0);for(let i=0;i<a.length;i+=2){xs.push(a[i]+q.tx);ys.push(a[i+1]+q.ty);}}return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};}
for(const kind of P.KINDS)for(const state of ['idle','working'])for(let i=0;i<=160;i++){
  const p=P.pose(kind,{state,time:i*.04,motion:true});
  for(const q of p.parts)for(const k of ['x','y','cx','cy','r','tx','ty','scale'])assert.ok(Number.isFinite(q[k]),k);
  const b=bounds(p);minMargin=Math.min(minMargin,b.left,b.top,256-b.right,256-b.bottom);samples++;
}
assert.ok(minMargin>25);
const spread=[];
for(const kind of P.KINDS){
  const a=P.pose(kind,{phase:'expanded'}),b=P.pose(kind,{phase:'compact'}),ba=bounds(a),bb=bounds(b);
  assert.equal(a.parts[2].id,'foreground');assert.equal(a.parts[2].transform,b.parts[2].transform);
  assert.ok(bb.right-bb.left<ba.right-ba.left,'The spread must actually gather');
  assert.deepEqual(P.pose(kind,{motion:true,time:0}),P.pose(kind,{motion:true,time:3.2}));
  assert.deepEqual(P.pose(kind,{motion:false,time:0}),P.pose(kind,{motion:false,time:12}));
  spread.push({kind,rest_width:Number((ba.right-ba.left).toFixed(2)),gathered_width:Number((bb.right-bb.left).toFixed(2))});
}
for(const time of [0,.4,1.4,2.1,3.2]){
  const a=previous.pose('parallel',{time,motion:true}),b=P.pose('original',{time,motion:true});
  for(let i=0;i<3;i++)for(const key of ['d','edge','x','y','cx','cy','r','color','light','transform'])assert.equal(a.parts[i][key],b.parts[i][key],key);
}

// Exercise the actual script with a non-browser attribute/event adapter.
function node(){return{attrs:{},dataset:{},value:'',checked:false,textContent:'',listeners:{},setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,fn){this.listeners[k]=fn;},fire(k){this.listeners[k]?.();}};}
const ids=['reference','candidate','kind','state','reference-caption','candidate-caption','candidate-title','announcement','pause','replay','compact','expanded','reduce'];
const els=Object.fromEntries(ids.map(k=>[k,node()]));els.kind.value='compact';els.state.value='working';
const makeLayers=()=>['background','working','foreground'].map(id=>{const n=node();n.dataset.layer=id;return n;});
const reference=makeLayers();let candidate=makeLayers();
els.reference.querySelectorAll=()=>reference;els.candidate.querySelectorAll=()=>candidate;
Object.defineProperty(els.candidate,'innerHTML',{set(s){assert.ok(s.includes('id="live-'));candidate=makeLayers();}});
const picks=P.KINDS.map(kind=>{const n=node();n.dataset.kind=kind;return n;});
const doc=node();doc.hidden=false;doc.getElementById=k=>els[k];doc.querySelectorAll=()=>picks;
const pref=node();pref.matches=false;const win=node();win.matchMedia=()=>pref;
let id=0;const queue=new Map();
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'),{ParallelVariations:P,document:doc,window:win,requestAnimationFrame(fn){const n=++id;queue.set(n,fn);return n;},cancelAnimationFrame(n){queue.delete(n);}});
const frame=t=>{const a=queue.entries().next().value;assert.ok(a,'Missing scheduled frame');queue.delete(a[0]);a[1](t);};
assert.equal(queue.size,1);const start=reference[0].attrs.transform;frame(0);for(let i=1;i<=30;i++)frame(i*40);
assert.notEqual(reference[0].attrs.transform,start);assert.notEqual(candidate[0].attrs.transform,reference[0].attrs.transform);
const freeze=reference.map(n=>n.attrs.transform);els.pause.fire('click');assert.equal(queue.size,0);assert.deepEqual(reference.map(n=>n.attrs.transform),freeze,'Pause must freeze the actual current pose');
els.pause.fire('click');assert.equal(queue.size,1);
els.reduce.checked=true;els.reduce.fire('change');assert.equal(queue.size,0);els.reduce.checked=false;pref.matches=true;pref.fire('change');assert.equal(queue.size,0);
pref.matches=false;pref.fire('change');assert.equal(queue.size,1);
doc.hidden=true;doc.fire('visibilitychange');assert.equal(queue.size,0);doc.hidden=false;doc.fire('visibilitychange');assert.equal(queue.size,1);
els.compact.fire('click');assert.equal(queue.size,0);const gathered=candidate[0].attrs.transform;els.expanded.fire('click');assert.notEqual(candidate[0].attrs.transform,gathered);
els.replay.fire('click');assert.equal(queue.size,1);
for(const p of picks){p.fire('click');assert.equal(els.kind.value,p.dataset.kind);assert.ok(els['candidate-title'].textContent.includes(P.NAMES[p.dataset.kind]));}
els.kind.value='original';els.kind.fire('change');frame(0);for(let i=1;i<20;i++)frame(i*40);
assert.deepEqual(candidate.map(n=>n.attrs.transform),reference.map(n=>n.attrs.transform),'Both views must share one clock');
els.state.value='idle';els.state.fire('change');assert.equal(queue.size,0);els.state.value='working';els.state.fire('change');assert.equal(queue.size,1);
win.fire('pagehide');assert.equal(queue.size,0);
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext)\s*\(/.test(html));
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));assert.ok(!/<!--(?:REFERENCE|CANDIDATE|CARDS)-->|\/\*(?:MODEL|PREVIEW)\*\//.test(html));
const staticHtml=html.split('<script>')[0],staticIds=[...staticHtml.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(new Set(staticIds).size,staticIds.length);
const report={pose_samples:samples,minimum_control_point_margin:Number(minMargin.toFixed(2)),spread,
 approved_reference:'Original matches previous Parallel geometry, material coordinates and working transforms at five sampled times. Pixel comparison is recorded by render.py.',
 checks:['stable foreground','actual contraction of the spread','exact 3.2s loop and static reduction','both comparison views share one clock','actual pause freezes current pose','six dropdown/card choices','gathered/resting controls','manual/system reduction','hidden-document/page-exit suspension','unique SVG namespaces and offline HTML'],
 scope:'Node geometry and preview attribute/event adapter. Browser layout, native interaction, gradients/clipping/playback and accessibility are unverified.'};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
