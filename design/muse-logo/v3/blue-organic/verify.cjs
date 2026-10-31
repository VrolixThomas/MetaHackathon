/* Non-browser geometry and actual preview event/attribute checks. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),F=require('./field.js');
const STATES=['idle','working','listening','speaking','offline'];
let samples=0,minMargin=Infinity,minGap=Infinity;
for(const kind of F.KINDS)for(const state of STATES)for(let i=0;i<=160;i++)for(const amplitude of [0,1]){
  const p=F.pose(kind,{state,time:i*.04,amplitude,motion:true});assert.deepEqual(p.center,{x:128,y:128});
  for(let j=0;j<64;j++){
    const a=p.outer[j],b=p.inner[j];
    assert.ok(a.concat(b).every(Number.isFinite));
    minMargin=Math.min(minMargin,...a.map(x=>Math.min(x,256-x)));
    const gap=Math.hypot(a[0]-128,a[1]-128)-Math.hypot(b[0]-128,b[1]-128);
    minGap=Math.min(minGap,gap);assert.ok(gap>12,'Opening crossed outer contour');
  }
  assert.ok(p.opacity>=0&&p.opacity<=1);samples++;
}
assert.ok(minMargin>50);
for(const kind of F.KINDS){
  const a=F.pose(kind,{phase:'expanded'}),b=F.pose(kind,{phase:'compact'});
  assert.equal(a.outerScale,1);assert.equal(b.outerScale,.83);assert.equal(b.innerScale,.7);assert.equal(b.lightScale,.87);
  assert.notEqual(a.d,b.d,'Contraction must change actual contour geometry');
  assert.deepEqual(F.pose(kind,{state:'working',motion:true,time:0}),F.pose(kind,{state:'working',motion:true,time:3.2}));
  assert.deepEqual(F.pose(kind,{state:'speaking',motion:false,time:0,amplitude:0}),F.pose(kind,{state:'speaking',motion:false,time:18,amplitude:1}));
}
assert.ok(F.gather(.16,0)>0&&F.gather(.16,.18)===0,'Contour staggering missing');
assert.ok(F.gather(3.05,0)<0,'Settling overshoot missing');

function node(){return{attrs:{},value:'',textContent:'',checked:false,listeners:{},setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,fn){this.listeners[k]=fn;},fire(k){this.listeners[k]?.();}};}
const ids=['kind','state','hero','variant-title','control-title','caption','announcement','pause','replay','compact','expanded','reduce','amplitude','amp-value','synthetic'];
const els=Object.fromEntries(ids.map(k=>[k,node()]));els.kind.value='bloom';els.state.value='working';els.amplitude.value='.5';
let contours=[node(),node()],lights=node(),field=node();
els.hero.querySelectorAll=()=>contours;els.hero.querySelector=q=>q==='[data-lights]'?lights:field;
Object.defineProperty(els.hero,'innerHTML',{set(s){assert.ok(s.includes('<clipPath')&&s.includes('clip-rule="evenodd"'));contours=[node(),node()];lights=node();field=node();}});
const doc=node();doc.hidden=false;doc.getElementById=k=>els[k];const pref=node();pref.matches=false;const win=node();win.matchMedia=()=>pref;
let id=0;const frames=new Map();
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'),{OrganicField:F,document:doc,window:win,requestAnimationFrame(fn){const n=++id;frames.set(n,fn);return n;},cancelAnimationFrame(n){frames.delete(n);}});
const frame=t=>{const a=frames.entries().next().value;assert.ok(a,'Missing scheduled frame');frames.delete(a[0]);a[1](t);};
assert.equal(frames.size,1);const start=contours[0].attrs.d;frame(0);for(let i=1;i<=32;i++)frame(i*40);
assert.notEqual(contours[0].attrs.d,start);assert.equal(contours[0].attrs.d,contours[1].attrs.d,'Body and light clip must share actual geometry');
assert.ok(lights.attrs.transform.includes('scale('));
els.reduce.checked=true;els.reduce.fire('change');assert.equal(frames.size,0);
els.synthetic.checked=true;els.synthetic.fire('change');assert.equal(frames.size,0);
els.reduce.checked=false;pref.matches=true;pref.fire('change');assert.equal(frames.size,0);
pref.matches=false;pref.fire('change');assert.equal(frames.size,1);
doc.hidden=true;doc.fire('visibilitychange');assert.equal(frames.size,0);doc.hidden=false;doc.fire('visibilitychange');assert.equal(frames.size,1);
els.compact.fire('click');assert.equal(frames.size,0);const compact=contours[0].attrs.d;
els.expanded.fire('click');assert.notEqual(contours[0].attrs.d,compact);assert.equal(frames.size,0);
els.replay.fire('click');assert.equal(frames.size,1);
for(const kind of F.KINDS){els.kind.value=kind;els.kind.fire('change');assert.equal(els['control-title'].textContent,F.NAMES[kind]);}
for(const state of STATES){els.state.value=state;els.state.fire('change');assert.ok(els.announcement.textContent.includes('Silent design simulation'));}
els.state.value='speaking';els.state.fire('change');frame(0);frame(40);els.pause.fire('click');assert.equal(frames.size,0);
els.state.value='working';els.state.fire('change');win.fire('pagehide');assert.equal(frames.size,0);
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));
assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext)\s*\(/.test(html));
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));
assert.ok(!/<!--(?:HERO|VARIANTS|SIZES|MONO|POSES)-->|\/\*(?:MODEL|PREVIEW)\*\//.test(html));
const report={pose_samples:samples,minimum_sampled_edge_margin:Number(minMargin.toFixed(2)),minimum_radial_body_gap:Number(minGap.toFixed(2)),
  compact:{outer_radius_ratio:.83,opening_radius_ratio:.7,light_scale:.87},
  checks:['fixed anchor','finite contours with retained opening','real independent body/opening/light contraction','staggered onset and settle','exact 3.2s seam','reduced motion ignores time/envelope','actual preview updates body and clip contours together','pause/replay, compact/open, five states and three variations','manual/system reduction, hidden-document and page-exit suspension','embedded HTML and no media/network APIs'],
  scope:'Node geometry and preview attribute/event adapter only. Not browser layout, clipPath playback, actual interaction or accessibility acceptance.'};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
