/* Semantic motion properties and actual preview script, without a browser. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),F=require('./focus.js');
let samples=0,minMargin=Infinity,maxHighlighted=0;
const visible=['d','color','primaryPeak','secondaryPeak','edgeOpacity','depth'];
function check(p){
  assert.equal(p.parts.length,3);assert.ok(p.parts.filter(q=>q.emphasis>1e-5).length<=1,'Two work items are highlighted at once');maxHighlighted=Math.max(maxHighlighted,p.parts.filter(q=>q.emphasis>.8).length);
  for(const q of p.parts){
    for(const k of ['x','y','cx','cy','r','depth','emphasis','primaryPeak','secondaryPeak','edgeOpacity'])assert.ok(Number.isFinite(q[k]),k);
    assert.ok(q.primaryPeak>=0&&q.primaryPeak<=1&&q.secondaryPeak>=0&&q.secondaryPeak<=1);
    const a=q.d.match(/-?\d+(?:\.\d+)?/g).map(Number);assert.equal(a.length%2,0);for(let i=0;i<a.length;i+=2)minMargin=Math.min(minMargin,a[i],a[i+1],256-a[i],256-a[i+1]);
    const v=q.vertices,turns=v.map((b,i)=>{const a=v[(i+3)%4],c=v[(i+1)%4];return(b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]);});assert.ok(turns.every(x=>x>0),'A handoff folded or inverted the surface');
  }
  samples++;
}
for(const kind of F.KINDS)for(const palette of Object.keys(F.PALETTES)){
  for(let i=0;i<=192;i++)check(F.pose(kind,{palette,time:i*.05,motion:true,auto:true}));
  for(let focusIndex=0;focusIndex<3;focusIndex++){
    for(let j=0;j<=40;j++)check(F.pose(kind,{palette,focusIndex,transition:j/40,time:1.2,motion:true}));
    const a=F.pose(kind,{palette,focusIndex,time:0,motion:true}),b=F.pose(kind,{palette,focusIndex,time:1.2,motion:true});
    const activeA=a.parts.find(q=>q.item===focusIndex),activeB=b.parts.find(q=>q.item===focusIndex);
    for(const k of visible)assert.equal(activeA[k],activeB[k],'Focused item moved or pulsed while held');
    assert.ok(a.parts.some(q=>q.item!==focusIndex&&q.d!==b.parts.find(r=>r.id===q.id).d),'Background work stopped');
    const end=F.pose(kind,{palette,focusIndex,transition:1,time:3.2,motion:true}),next=F.pose(kind,{palette,focusIndex:(focusIndex+1)%3,time:3.2,motion:true});
    for(const q of end.parts)for(const k of visible)assert.equal(q[k],next.parts.find(p=>p.id===q.id)[k],'Discontinuous handoff');
    assert.deepEqual(F.pose(kind,{palette,focusIndex,motion:false,time:0,auto:true}),F.pose(kind,{palette,focusIndex,motion:false,time:25,auto:true}));
  }
  assert.deepEqual(F.pose(kind,{palette,motion:true,auto:true,time:0}),F.pose(kind,{palette,motion:true,auto:true,time:F.TOUR}));
}
assert.ok(minMargin>25);assert.equal(maxHighlighted,1);assert.equal(F.tour(0).focusIndex,0);assert.equal(F.tour(3.2).focusIndex,1);assert.equal(F.tour(6.4).focusIndex,2);assert.equal(F.tour(9.6).focusIndex,0);

// Minimal attribute/event adapter for the actual handoff controller.
function node(){return{attrs:{},dataset:{},value:'',checked:false,textContent:'',listeners:{},setAttribute(k,v){this.attrs[k]=String(v);},addEventListener(k,fn){this.listeners[k]=fn;},fire(k){this.listeners[k]?.();}};}
function makeSVG(){
  const svg=node();svg.items={};svg.nodes=[];
  for(let i=0;i<3;i++){
    const layer=node(),surface=node(),edge=node(),clip=node();layer.dataset.layer=`item-${i}`;
    const lights=['primary','secondary'].map(channel=>{const g=node();g.dataset.channel=channel;const circle=node(),stops=Array.from({length:17},(_,j)=>{const n=node(),t=j/16;n.dataset.falloff=String(Math.max(0,(Math.exp(-t*t/.3)-Math.exp(-1/.3))/(1-Math.exp(-1/.3))));return n;});g.querySelector=()=>circle;g.querySelectorAll=()=>stops;return g;});
    layer.querySelector=q=>q==='[data-surface]'?surface:edge;layer.querySelectorAll=()=>lights;
    svg.items[`item-${i}`]={layer,surface,edge,clip,lights};svg.nodes.unshift(layer);
  }
  svg.querySelectorAll=()=>svg.nodes.slice();svg.querySelector=q=>svg.items[q.match(/item-\d/)[0]].clip;
  svg.appendChild=n=>{svg.nodes=svg.nodes.filter(q=>q!==n);svg.nodes.push(n);};return svg;
}
const ids=['hero','kind','palette','next','pause','reset','background','auto','reduce','layout-title','focus-caption','announcement'];
const els=Object.fromEntries(ids.map(id=>[id,node()]));els.kind.value='plane';els.palette.value='blue';els.background.checked=true;
let currentSVG=makeSVG(),lastSVG='';els.hero.querySelector=()=>currentSVG;
Object.defineProperty(els.hero,'innerHTML',{set(s){assert.ok(s.includes('id="live-'));lastSVG=s;currentSVG=makeSVG();}});
const picks=F.KINDS.map(kind=>{const n=node();n.dataset.kind=kind;return n;});
const doc=node();doc.hidden=false;doc.getElementById=k=>els[k];doc.querySelectorAll=()=>picks;
const pref=node();pref.matches=false;const win=node();win.matchMedia=()=>pref;
let id=0,now=0,lastPose;const queue=new Map();
const model={...F,pose(...args){lastPose=F.pose(...args);return lastPose;}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'preview.js'),'utf8'),{FocusTheme:model,document:doc,window:win,requestAnimationFrame(fn){const n=++id;queue.set(n,fn);return n;},cancelAnimationFrame(n){queue.delete(n);}});
function frame(){const q=queue.entries().next().value;assert.ok(q,'Missing frame');queue.delete(q[0]);now+=40;q[1](now);}
function advance(seconds){for(let i=0;i<Math.ceil(seconds/.04);i++)frame();}
function verifyDraw(){
  assert.deepEqual(currentSVG.nodes.map(n=>n.dataset.layer),lastPose.parts.map(q=>q.id));
  for(const q of lastPose.parts){const n=currentSVG.items[q.id];assert.equal(n.surface.attrs.d,q.d);assert.equal(n.clip.attrs.d,q.d);assert.equal(n.surface.attrs.fill,q.color);assert.equal(Number(n.edge.attrs.opacity),q.edgeOpacity);}
}
assert.equal(queue.size,1);assert.equal(els.auto.checked,false);
const held=currentSVG.items['item-0'].surface.attrs.d,bg=currentSVG.items['item-1'].surface.attrs.d;advance(1.3);
assert.equal(currentSVG.items['item-0'].surface.attrs.d,held);assert.notEqual(currentSVG.items['item-1'].surface.attrs.d,bg);verifyDraw();
const frozen=Object.values(currentSVG.items).map(n=>n.surface.attrs.d);els.pause.fire('click');assert.equal(queue.size,0);assert.deepEqual(Object.values(currentSVG.items).map(n=>n.surface.attrs.d),frozen);els.pause.fire('click');assert.equal(queue.size,1);
els.next.fire('click');advance(1);assert.ok(els['focus-caption'].textContent.includes('item 2'));verifyDraw();
els.next.fire('click');els.next.fire('click');advance(1);assert.ok(els['focus-caption'].textContent.includes('item 3'),'Rapid Next skipped an item');advance(4);assert.ok(els['focus-caption'].textContent.includes('item 3'),'Manual focus advanced without Next');
els.reset.fire('click');assert.ok(els['focus-caption'].textContent.includes('item 1'));
els.auto.checked=true;els.auto.fire('change');advance(3.6);assert.ok(els['focus-caption'].textContent.includes('item 2'));els.next.fire('click');assert.equal(els.auto.checked,false);advance(1);assert.ok(els['focus-caption'].textContent.includes('item 3'));
els.reduce.checked=true;els.reduce.fire('change');assert.equal(queue.size,0);els.next.fire('click');assert.ok(els['focus-caption'].textContent.includes('item 1'));assert.equal(queue.size,0);
els.auto.checked=true;els.auto.fire('change');assert.equal(els.auto.checked,false);assert.equal(queue.size,0);
els.reduce.checked=false;els.reduce.fire('change');pref.matches=true;pref.fire('change');assert.equal(queue.size,0);pref.matches=false;pref.fire('change');assert.equal(queue.size,1);
doc.hidden=true;doc.fire('visibilitychange');assert.equal(queue.size,0);doc.hidden=false;doc.fire('visibilitychange');assert.equal(queue.size,1);
els.background.checked=false;els.background.fire('change');assert.equal(queue.size,0);els.background.checked=true;els.background.fire('change');assert.equal(queue.size,1);
for(const n of picks){n.fire('click');assert.equal(els.kind.value,n.dataset.kind);assert.ok(lastSVG.includes(F.NAMES[n.dataset.kind]));verifyDraw();}
for(const palette of Object.keys(F.PALETTES)){els.palette.value=palette;els.palette.fire('change');assert.ok(lastSVG.includes(F.PALETTES[palette].bg));verifyDraw();}
win.fire('pagehide');assert.equal(queue.size,0);
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext)\s*\(/.test(html));assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));
assert.ok(!/<!--(?:HERO|CARDS|KEYFRAMES)-->|\/\*(?:MODEL|PREVIEW)\*\//.test(html));const staticHtml=html.split('<script>')[0],allIds=[...staticHtml.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(new Set(allIds).size,allIds.length);
const report={pose_samples:samples,maximum_simultaneously_highlighted_surfaces:maxHighlighted,minimum_control_point_margin:Number(minMargin.toFixed(2)),tour_sequence:[0,1,2,0],
 checks:['held focus surface is geometrically and materially stationary','background surfaces continue moving','never two highlighted items during handoff','convex surfaces throughout perspective interpolation','continuous handoff and exact 9.6s tour seam','reduced motion is fixed with immediate manual Next','actual controller updates surface/clip/light and paint order','Next advances once and holds until requested','optional auto demo with manual takeover','pause freezes pose','layout/palette preserve focus','system/manual reduction and hidden/page-exit suspension','offline HTML and unique SVG IDs'],
 scope:'Node model and actual preview attribute/event adapter only. Browser layout, native controls, gradient/clipping/playback and accessibility remain unverified.'};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
