/* Exact selected geometry, focus semantics and the reusable controller, no browser. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),M=require('../motion/pull-forward.js');
const root=path.resolve(__dirname,'..');
let samples=0,minMargin=Infinity;
for(let focusIndex=0;focusIndex<3;focusIndex++){
  for(let j=0;j<=100;j++)for(const time of [0,1.2]){
    const p=M.pose({focusIndex,transition:j/100,time,motion:true});assert.equal(p.kind,'pull');assert.equal(p.palette,'blue');assert.equal(p.parts.length,3);
    assert.ok(p.parts.filter(q=>q.emphasis>1e-5).length<=1,'More than one highlighted item');
    for(const q of p.parts){for(const k of ['x','y','cx','cy','r','emphasis','primaryPeak','secondaryPeak'])assert.ok(Number.isFinite(q[k]));const a=q.d.match(/-?\d+(?:\.\d+)?/g).map(Number);for(let i=0;i<a.length;i+=2)minMargin=Math.min(minMargin,a[i],a[i+1],256-a[i],256-a[i+1]);}
    samples++;
  }
  const a=M.pose({focusIndex,time:0,motion:true}),b=M.pose({focusIndex,time:1.2,motion:true});
  for(const k of ['d','color','primaryPeak','secondaryPeak','edgeOpacity'])assert.equal(a.parts.find(q=>q.item===focusIndex)[k],b.parts.find(q=>q.item===focusIndex)[k]);
  assert.ok(a.parts.some(q=>q.item!==focusIndex&&q.d!==b.parts.find(r=>r.id===q.id).d));
  assert.deepEqual(M.pose({focusIndex,time:0,motion:false,auto:true}),M.pose({focusIndex,time:25,motion:false,auto:true}));
}
assert.ok(minMargin>25);assert.deepEqual(M.pose({time:0,motion:true,auto:true}),M.pose({time:M.TOUR,motion:true,auto:true}));
assert.deepEqual([0,3.2,6.4,9.6].map(t=>M.tour(t).focusIndex),[0,1,2,0]);
assert.equal(M.KINDS,undefined,'Only the selected final mark should be exported');

function node(){
  return {attrs:{},dataset:{},textContent:'',innerHTML:'',listeners:new Map(),
    setAttribute(k,v){this.attrs[k]=String(v);},removeAttribute(k){delete this.attrs[k];},
    addEventListener(k,fn){if(!this.listeners.has(k))this.listeners.set(k,new Set());this.listeners.get(k).add(fn);},
    removeEventListener(k,fn){this.listeners.get(k)?.delete(fn);},fire(k){for(const fn of [...(this.listeners.get(k)||[])])fn();},
    listenerCount(){return [...this.listeners.values()].reduce((n,s)=>n+s.size,0);}
  };
}
function makeSVG(){
  const svg=node();svg.items={};svg.nodes=[];
  for(let i=0;i<3;i++){
    const layer=node(),surface=node(),edge=node(),clip=node();layer.dataset.layer=`item-${i}`;
    const lights=['primary','secondary'].map(channel=>{const g=node();g.dataset.channel=channel;const circle=node(),stops=Array.from({length:17},(_,j)=>{const n=node(),t=j/16;n.dataset.falloff=String(Math.max(0,(Math.exp(-t*t/.3)-Math.exp(-1/.3))/(1-Math.exp(-1/.3))));return n;});g.querySelector=()=>circle;g.querySelectorAll=()=>stops;return {g,circle,stops};});
    layer.querySelector=q=>q==='[data-surface]'?surface:edge;layer.querySelectorAll=()=>lights.map(l=>l.g);svg.items[`item-${i}`]={layer,surface,edge,clip,lights};svg.nodes.unshift(layer);
  }
  svg.querySelectorAll=()=>svg.nodes.slice();svg.querySelector=q=>svg.items[q.match(/item-\d/)[0]].clip;svg.appendChild=n=>{svg.nodes=svg.nodes.filter(q=>q!==n);svg.nodes.push(n);};return svg;
}
const doc=node();doc.hidden=false;const pref=node();pref.matches=false;const win=node();win.matchMedia=()=>pref;
let frameId=0,now=0;const frames=new Map();
const context={module:{exports:{}},require:p=>{assert.equal(p,'./pull-forward.js');return M;},document:doc,window:win,requestAnimationFrame(fn){const id=++frameId;frames.set(id,fn);return id;},cancelAnimationFrame(id){frames.delete(id);}};
vm.runInNewContext(fs.readFileSync(path.join(root,'motion/controller.js'),'utf8'),context);const Controller=context.module.exports;
function host(){const n=node();n.classList={add(){}};n.style={setProperty(){}};n.svg=makeSVG();n.querySelector=()=>n.svg;Object.defineProperty(n,'innerHTML',{set(s){assert.ok(s.includes('id="live-'));n.svg=makeSVG();n.lastHTML=s;}});return n;}
const h=host();let events=0;const c=new Controller(h,{size:96,onStateChange:()=>events++});
const frame=()=>{const a=frames.entries().next().value;assert.ok(a,'Missing scheduled frame');frames.delete(a[0]);now+=40;a[1](now);};
const advance=(seconds,allowQuiescence=false)=>{for(let i=0;i<Math.ceil(seconds/.04);i++){if(allowQuiescence&&frames.size===0)break;frame();}};
function verifyDraw(){const p=M.pose({focusIndex:c.focusIndex,transition:c.transition,time:c.time,motion:!c.reduced(),background:c.background});assert.deepEqual(h.svg.nodes.map(n=>n.dataset.layer),p.parts.map(q=>q.id));for(const q of p.parts){const n=h.svg.items[q.id];assert.equal(n.surface.attrs.d,q.d);assert.equal(n.clip.attrs.d,q.d);assert.equal(Number(n.edge.attrs.opacity),q.edgeOpacity);assert.equal(n.surface.attrs.fill,c.theme==='dark'?q.color:'#'+[1,3,5].map(i=>Math.round(parseInt(q.color.slice(i,i+2),16)*.84).toString(16).padStart(2,'0')).join(''));}}
assert.equal(frames.size,1);assert.equal(h.svg.attrs['aria-hidden'],'true');const fg=h.svg.items['item-0'].surface.attrs.d,bg=h.svg.items['item-1'].surface.attrs.d;advance(1.3);assert.equal(h.svg.items['item-0'].surface.attrs.d,fg);assert.notEqual(h.svg.items['item-1'].surface.attrs.d,bg);verifyDraw();
const hold=Object.values(h.svg.items).map(n=>n.surface.attrs.d);c.pause();assert.equal(frames.size,0);assert.deepEqual(Object.values(h.svg.items).map(n=>n.surface.attrs.d),hold);c.resume();assert.equal(frames.size,1);
assert.equal(c.advance(),true);assert.equal(c.advance(),false);advance(1);assert.equal(c.getState().focusIndex,1);assert.equal(c.getState().transitioning,false);advance(4);assert.equal(c.getState().focusIndex,1,'Controller must never auto-advance');verifyDraw();
c.setBackgroundMotion(false);assert.equal(frames.size,0);assert.equal(c.advance(),true);advance(1,true);assert.equal(c.getState().focusIndex,2);assert.equal(frames.size,0);
c.setReducedMotion(true);assert.equal(c.advance(),true);assert.equal(c.getState().focusIndex,0);assert.equal(frames.size,0);
c.setReducedMotion(false);c.setBackgroundMotion(true);assert.equal(frames.size,1);pref.matches=true;pref.fire('change');assert.equal(frames.size,0);c.setReducedMotion(false);assert.equal(frames.size,0,'System reduction must win');c.advance();assert.equal(c.getState().focusIndex,1);
pref.matches=false;pref.fire('change');assert.equal(frames.size,1);doc.hidden=true;doc.fire('visibilitychange');assert.equal(frames.size,0);doc.hidden=false;doc.fire('visibilitychange');assert.equal(frames.size,1);
c.setTheme('light');assert.equal(c.getState().focusIndex,1);verifyDraw();c.setTheme('dark');verifyDraw();
c.reset();assert.equal(c.getState().focusIndex,0);const beforeDestroy=events;c.destroy();assert.equal(frames.size,0);assert.equal(pref.listenerCount(),0);assert.equal(doc.listenerCount(),0);assert.equal(win.listenerCount(),0);assert.equal(c.getState().destroyed,true);assert.equal(c.advance(),false);pref.fire('change');assert.equal(events,beforeDestroy);

// A synchronous callback may advance again; it must not create two RAF loops.
let reentered=false,c2;const h2=host();c2=new Controller(h2,{decorative:false,label:'Pull forward brand mark',onStateChange:s=>{if(c2&&!reentered&&s.focusIndex===1&&!s.transitioning){reentered=true;c2.advance();}}});assert.equal(h2.svg.attrs['aria-label'],'Pull forward brand mark');assert.equal(h2.svg.attrs['aria-labelledby'],undefined);c2.advance();advance(1);assert.equal(frames.size,1);assert.equal(reentered,true);c2.destroy();assert.equal(frames.size,0);
const ha=host(),hb=host(),ca=new Controller(ha),cb=new Controller(hb);assert.equal(frames.size,2);const idsA=new Set([...ha.lastHTML.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]));assert.ok([...hb.lastHTML.matchAll(/\bid="([^"]+)"/g)].every(x=>!idsA.has(x[1])));ca.destroy();assert.equal(frames.size,1);cb.destroy();assert.equal(frames.size,0);

const html=fs.readFileSync(path.join(root,'index.html'),'utf8');assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext)\s*\(/.test(html));assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));assert.ok(!/<!--(?:SMALL|MONO)-->|\/\*(?:CSS|MODEL|CONTROLLER|DEMO)\*\//.test(html));
const report={pose_samples:samples,minimum_control_point_margin:Number(minMargin.toFixed(2)),
  checks:['selected Pull forward only','one highlight maximum','held foreground stable and background active','exact tour seam and reduced still','actual reusable controller updates paths/clip/lights/order','explicit advance once and hold','no automatic advance','pause/resume and no-background mode','immediate reduced/paused advance','system reduction wins','light/dark switching preserves focus','hidden suspension','destroy cancels frames and removes listeners','reentrant callback cannot duplicate RAF loops','custom accessible label source binding','multiple controllers have independent frames and unique SVG IDs','self-contained offline preview'],
  scope:'Node geometry and actual controller attribute/event adapter. Native browser layout, controls, SVG animation/gradients/clipping/playback and OS app integration are not tested.'};
fs.mkdirSync(path.join(root,'preview'),{recursive:true});fs.writeFileSync(path.join(root,'preview/validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
