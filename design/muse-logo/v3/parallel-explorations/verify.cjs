/* Form, independent colour, motion and actual controller probes. No browser. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),P=require('./planes.js');
const old=require('../reset/marks.js');
let samples=0,minMargin=Infinity;
function bounds(pose){const xs=[],ys=[];for(const q of pose.parts){const a=q.d.match(/-?\d+(?:\.\d+)?/g).map(Number);assert.equal(a.length%2,0);for(let i=0;i<a.length;i+=2){xs.push(q.x+(a[i]-q.x)*q.scale+q.tx);ys.push(q.y+(a[i+1]-q.y)*q.scale+q.ty);}}return{l:Math.min(...xs),r:Math.max(...xs),t:Math.min(...ys),b:Math.max(...ys)};}
for(const kind of P.KINDS)for(const state of ['idle','working'])for(let i=0;i<=160;i++){
  const p=P.pose(kind,{state,time:i*.04,motion:true});assert.equal(p.parts.length,3);
  for(const q of p.parts){for(const key of ['x','y','cx','cy','r','tx','ty','scale'])assert.ok(Number.isFinite(q[key]),key);assert.ok(q.scale>.9&&q.scale<1.1);}
  const b=bounds(p);minMargin=Math.min(minMargin,b.l,b.t,256-b.r,256-b.b);samples++;
}
assert.ok(minMargin>25);
const contractions=[];
for(const kind of P.KINDS){
  const a=P.pose(kind,{phase:'expanded'}),b=P.pose(kind,{phase:'compact'}),ba=bounds(a),bb=bounds(b);
  assert.equal(a.parts[2].transform,b.parts[2].transform,'Primary surface must stay fixed');
  assert.ok(bb.r-bb.l<ba.r-ba.l||bb.b-bb.t<ba.b-ba.t,'Spread must physically contract');
  assert.deepEqual(P.pose(kind,{motion:true,time:0}),P.pose(kind,{motion:true,time:3.2}));assert.deepEqual(P.pose(kind,{motion:false,time:0}),P.pose(kind,{motion:false,time:12}));
  contractions.push({kind,rest:[ba.r-ba.l,ba.b-ba.t].map(x=>Number(x.toFixed(2))),gathered:[bb.r-bb.l,bb.b-bb.t].map(x=>Number(x.toFixed(2)))});
  const base=P.forms(kind,'blue');
  for(const palette of Object.keys(P.PALETTES)){
    const colored=P.forms(kind,palette);for(let i=0;i<3;i++)for(const k of ['d','edge','x','y','cx','cy','r'])assert.equal(base[i][k],colored[i][k],'Palette changed geometry');
    assert.ok(P.svg(kind,{palette}).includes(P.PALETTES[palette].base[2]));
  }
}
for(const time of [0,.4,1.4,2.1,3.2]){
  const a=old.pose('parallel',{time,motion:true}),b=P.pose('original',{palette:'blue',time,motion:true});
  for(let i=0;i<3;i++)for(const key of ['d','edge','x','y','cx','cy','r','color','light','transform'])assert.equal(a.parts[i][key],b.parts[i][key]);
}

function node(){return{attrs:{},dataset:{},value:'',checked:false,textContent:'',listeners:{},setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,fn){this.listeners[k]=fn;},fire(k){this.listeners[k]?.();}};}
const ids=['reference','candidate','kind','palette','state','reference-caption','candidate-caption','candidate-title','announcement','pause','replay','compact','expanded','reduce'];
const els=Object.fromEntries(ids.map(id=>[id,node()]));els.kind.value='fan';els.palette.value='lagoon';els.state.value='working';
const makeLayers=()=>['background','working','foreground'].map(id=>{const n=node();n.dataset.layer=id;return n;});
const reference=makeLayers();let candidate=makeLayers(),lastSVG='';
els.reference.querySelectorAll=()=>reference;els.candidate.querySelectorAll=()=>candidate;
Object.defineProperty(els.candidate,'innerHTML',{set(s){assert.ok(s.includes('id="live-'));lastSVG=s;candidate=makeLayers();}});
const formPicks=P.KINDS.map(kind=>{const n=node();n.dataset.kind=kind;n.dataset.palette=P.DEFAULTS[kind];return n;});
const colorPicks=Object.keys(P.PALETTES).map(p=>{const n=node();n.dataset.palette=p;return n;});
const doc=node();doc.hidden=false;doc.getElementById=k=>els[k];doc.querySelectorAll=q=>q==='.form-pick'?formPicks:colorPicks;
const pref=node();pref.matches=false;const win=node();win.matchMedia=()=>pref;
let id=0;const queue=new Map();
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'),{ParallelExplorations:P,document:doc,window:win,requestAnimationFrame(fn){const n=++id;queue.set(n,fn);return n;},cancelAnimationFrame(n){queue.delete(n);}});
const frame=t=>{const a=queue.entries().next().value;assert.ok(a,'Missing frame');queue.delete(a[0]);a[1](t);};
assert.equal(queue.size,1);const start=candidate[0].attrs.transform;frame(0);for(let i=1;i<=30;i++)frame(i*40);assert.notEqual(candidate[0].attrs.transform,start);
const frozen=candidate.map(n=>n.attrs.transform);els.pause.fire('click');assert.equal(queue.size,0);assert.deepEqual(candidate.map(n=>n.attrs.transform),frozen);els.pause.fire('click');assert.equal(queue.size,1);
els.reduce.checked=true;els.reduce.fire('change');assert.equal(queue.size,0);els.reduce.checked=false;pref.matches=true;pref.fire('change');assert.equal(queue.size,0);pref.matches=false;pref.fire('change');assert.equal(queue.size,1);
doc.hidden=true;doc.fire('visibilitychange');assert.equal(queue.size,0);doc.hidden=false;doc.fire('visibilitychange');assert.equal(queue.size,1);
els.compact.fire('click');assert.equal(queue.size,0);const together=candidate[0].attrs.transform;els.expanded.fire('click');assert.notEqual(candidate[0].attrs.transform,together);els.replay.fire('click');assert.equal(queue.size,1);
for(const n of formPicks){n.fire('click');assert.equal(els.kind.value,n.dataset.kind);assert.equal(els.palette.value,n.dataset.palette);assert.ok(lastSVG.includes(P.PALETTES[n.dataset.palette].bg));}
for(const n of colorPicks){const before=els.kind.value;n.fire('click');assert.equal(els.kind.value,before);assert.equal(els.palette.value,n.dataset.palette);assert.ok(lastSVG.includes(P.PALETTES[n.dataset.palette].bg));}
els.kind.value='horizon';els.kind.fire('change');assert.equal(els.palette.value,'citrine','Structure selector must preserve palette');
els.palette.value='violet';els.palette.fire('change');assert.equal(els.kind.value,'horizon','Palette selector must preserve structure');
els.kind.value='original';els.kind.fire('change');frame(0);for(let i=1;i<20;i++)frame(i*40);assert.deepEqual(candidate.map(n=>n.attrs.transform),reference.map(n=>n.attrs.transform));
els.state.value='idle';els.state.fire('change');assert.equal(queue.size,0);els.state.value='working';els.state.fire('change');win.fire('pagehide');assert.equal(queue.size,0);
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext)\s*\(/.test(html));assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));
assert.ok(!/<!--(?:REFERENCE|CANDIDATE|FORM_OPTIONS|COLOR_OPTIONS|FORM_CARDS|PALETTE_CARDS)-->|\/\*(?:MODEL|PREVIEW)\*\//.test(html));
const staticHtml=html.split('<script>')[0],staticIds=[...staticHtml.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(new Set(staticIds).size,staticIds.length);
const report={pose_samples:samples,minimum_control_point_margin:Number(minMargin.toFixed(2)),form_palette_combinations:36,contractions,
 checks:['six distinct three-surface arrangements','palette selection leaves geometry unchanged','primary surface fixed','actual contraction and small part scaling','exact 3.2s loop and static reduction','Original geometry/material/motion matches selected source','actual controller preserves independent form/colour selection','preset and palette buttons','pause freezes current pose','manual/system reduction and hidden/page-exit suspension','shared comparison clock','unique SVG IDs and offline packaging'],
 scope:'Node geometry, source and actual preview attribute/event adapter. Native browser layout, controls, gradients/clipping/playback and accessibility are unverified.'};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
