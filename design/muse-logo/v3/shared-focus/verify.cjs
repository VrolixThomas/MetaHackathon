/* Meaningful geometry and actual preview wiring checks; no browser. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),S=require('./focus.js');
const STATES=['idle','working','listening','speaking','offline'];
let samples=0,minMargin=Infinity;
const dist=([x,y])=>Math.hypot(x-S.FOCUS.x,y-S.FOCUS.y);
function inside([x,y],points){let c=false;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if(((a[1]>y)!==(b[1]>y))&&(x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]))c=!c;}return c;}
for(const state of STATES)for(let i=0;i<=160;i++)for(const amplitude of [0,1]){
  const p=S.pose({state,time:i*.04,amplitude,motion:true});assert.deepEqual(p.focus,S.FOCUS);
  for(const q of p.points){assert.ok(q.every(Number.isFinite));minMargin=Math.min(minMargin,...q.map(x=>Math.min(x,256-x)));}
  for(const q of p.signals){for(const key of ['x','y','r','opacity','progress','threadOpacity'])assert.ok(Number.isFinite(q[key]));assert.ok(q.r>0&&q.opacity>=0&&q.opacity<=1);minMargin=Math.min(minMargin,q.x-q.r,q.y-q.r,256-q.x-q.r,256-q.y-q.r);}
  samples++;
}
assert.ok(minMargin>35);
const open=S.pose({phase:'expanded'}),compact=S.pose({phase:'compact'});
assert.equal(compact.bodyScale,.87);assert.equal(compact.lightScale,.9);
for(let i=0;i<3;i++){
  const a=open.signals[i],b=compact.signals[i];
  assert.ok(dist([b.x,b.y])<dist([a.x,a.y]));assert.ok(b.r<a.r);assert.ok(b.threadOpacity<a.threadOpacity);
  assert.ok(inside([b.x,b.y],compact.points),`Signal ${i} must enter the shared context, not just vanish`);
}
const contextRatio=compact.points.reduce((s,p)=>s+dist(p),0)/open.points.reduce((s,p)=>s+dist(p),0);
assert.ok(contextRatio<.9);
assert.deepEqual(S.pose({motion:true,time:0}),S.pose({motion:true,time:3.2}));
assert.deepEqual(S.pose({state:'speaking',motion:false,time:0,amplitude:0}),S.pose({state:'speaking',motion:false,time:20,amplitude:1}));
assert.ok(S.gather(.1,0)>0&&S.gather(.1,.12)===0);assert.ok(S.gather(3.05,0)<0);

function n(){return{attrs:{},dataset:{},value:'',checked:false,textContent:'',listeners:{},setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,fn){this.listeners[k]=fn;},fire(k){this.listeners[k]?.();}};}
const ids=['state','hero','caption','announcement','pause','replay','compact','expanded','reduce','amplitude','amp-value','synthetic'];
const els=Object.fromEntries(ids.map(k=>[k,n()]));els.state.value='working';els.amplitude.value='.5';
const contours=[n(),n()],lights=n(),field=n();
const signals=[0,1,2].map(i=>{const a=n();a.dataset.signal=String(i);return a;});
const halos=[0,1,2].map(i=>{const a=n();a.dataset.signalHalo=String(i);return a;});
const threads=[0,1,2].map(i=>{const a=n();a.dataset.thread=String(i);return a;});
els.hero.querySelectorAll=q=>({'[data-contour]':contours,'[data-signal]':signals,'[data-signal-halo]':halos,'[data-thread]':threads}[q]);
els.hero.querySelector=q=>q==='[data-lights]'?lights:field;
const doc=n();doc.hidden=false;doc.getElementById=k=>els[k];const pref=n();pref.matches=false;const win=n();win.matchMedia=()=>pref;
let id=0;const frames=new Map();
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'),{SharedFocus:S,document:doc,window:win,requestAnimationFrame(fn){const i=++id;frames.set(i,fn);return i;},cancelAnimationFrame(i){frames.delete(i);}});
const frame=t=>{const a=frames.entries().next().value;assert.ok(a,'Missing frame');frames.delete(a[0]);a[1](t);};
assert.equal(frames.size,1);const initialD=contours[0].attrs.d,initialX=signals[0].attrs.cx,initialThread=threads[0].attrs.d;
frame(0);for(let i=1;i<=35;i++)frame(i*40);
assert.notEqual(contours[0].attrs.d,initialD);assert.equal(contours[0].attrs.d,contours[1].attrs.d);
assert.notEqual(signals[0].attrs.cx,initialX);assert.notEqual(threads[0].attrs.d,initialThread);assert.ok(halos[0].attrs.transform.includes('translate('));
els.reduce.checked=true;els.reduce.fire('change');assert.equal(frames.size,0);
els.synthetic.checked=true;els.synthetic.fire('change');assert.equal(frames.size,0);
els.reduce.checked=false;pref.matches=true;pref.fire('change');assert.equal(frames.size,0);
pref.matches=false;pref.fire('change');assert.equal(frames.size,1);
doc.hidden=true;doc.fire('visibilitychange');assert.equal(frames.size,0);doc.hidden=false;doc.fire('visibilitychange');assert.equal(frames.size,1);
els.compact.fire('click');assert.equal(frames.size,0);const gathered=signals[0].attrs.cx;
els.expanded.fire('click');assert.equal(frames.size,0);assert.notEqual(signals[0].attrs.cx,gathered);
els.replay.fire('click');assert.equal(frames.size,1);
for(const state of STATES){els.state.value=state;els.state.fire('change');assert.ok(els.announcement.textContent.includes('Silent design simulation'));}
els.state.value='speaking';els.state.fire('change');frame(0);frame(40);els.pause.fire('click');assert.equal(frames.size,0);
els.state.value='working';els.state.fire('change');win.fire('pagehide');assert.equal(frames.size,0);
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext)\s*\(/.test(html));
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));assert.ok(!/<!--(?:HERO|SIZES|MONO|POSES)-->|\/\*(?:MODEL|PREVIEW)\*\//.test(html));
const report={pose_samples:samples,fixed_focus:S.FOCUS,minimum_sampled_edge_margin:Number(minMargin.toFixed(2)),mean_context_distance_ratio:Number(contextRatio.toFixed(3)),
  checks:['signals physically enter context polygon','independent curved intake paths and shrinking particles','actual context contraction toward fixed focus','stagger, overshoot and exact 3.2s loop seam','reduced motion ignores time/envelope','actual preview updates body/clip, signals, halos and intake paths','pause/replay, compact/open and five states','manual/system reduction, hidden-document and page-exit suspension','self-contained HTML and no network/media APIs'],
  scope:'Node geometry and preview attribute/event adapter. Does not prove browser layout, native clipping/playback, real interaction or accessibility.'};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
