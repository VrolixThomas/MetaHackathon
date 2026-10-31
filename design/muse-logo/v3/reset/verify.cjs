/* Bounded checks of actual part movement, static identity and offline packaging. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),M=require('./marks.js');
let samples=0,minMargin=Infinity;
for(const kind of M.KINDS)for(const state of ['idle','working'])for(let i=0;i<=160;i++){
  const p=M.pose(kind,{state,time:i*.04,motion:true});
  for(const q of p.parts){
    for(const key of ['tx','ty','scale','x','y','r','cx','cy'])assert.ok(Number.isFinite(q[key]),key);
    assert.ok(q.scale>.9&&q.scale<1.1);
    const coords=q.d.match(/-?\d+(?:\.\d+)?/g).map(Number);assert.equal(coords.length%2,0);
    for(let j=0;j<coords.length;j+=2){const x=q.x+(coords[j]-q.x)*q.scale+q.tx,y=q.y+(coords[j+1]-q.y)*q.scale+q.ty;minMargin=Math.min(minMargin,x,y,256-x,256-y);}
  }
  samples++;
}
assert.ok(minMargin>25);
const movements=[];
for(const kind of M.KINDS){
  const a=M.pose(kind,{phase:'expanded'}),b=M.pose(kind,{phase:'compact'});
  assert.ok(a.parts.some((p,i)=>p.transform!==b.parts[i].transform),'No actual alignment motion');
  const stable=kind==='relay'?'intent':kind==='synthesis'?'shared':'foreground';
  assert.equal(a.parts.find(p=>p.id===stable).transform,b.parts.find(p=>p.id===stable).transform);
  assert.deepEqual(M.pose(kind,{motion:true,time:0}),M.pose(kind,{motion:true,time:3.2}));
  assert.deepEqual(M.pose(kind,{motion:false,time:0}),M.pose(kind,{motion:false,time:13}));
  movements.push({kind,stable_part:stable,parts:a.parts.filter((p,i)=>p.transform!==b.parts[i].transform).map(p=>p.id)});
  const svg=M.svg(kind,{idPrefix:'live'});assert.ok(svg.includes('id="live-'));
  assert.ok(!/<image\b|<text\b|<ellipse\b/.test(svg),'Raster, wordmark or previous oval vocabulary returned');
}
assert.ok(M.gather(3.05,0)<0);
const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
assert.ok(html.includes("connect-src 'none'")&&html.includes("media-src 'none'"));
assert.ok(!/\b(?:fetch|XMLHttpRequest|WebSocket|getUserMedia|AudioContext)\s*\(/.test(html));
assert.ok(!/<(?:script|link)[^>]+(?:src|href)=/.test(html));
assert.ok(!/<!--(?:CARDS|HERO)-->|\/\*(?:MODEL|PREVIEW)\*\//.test(html));
const body=html.split('<script>')[0],ids=[...body.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
assert.equal(new Set(ids).size,ids.length,'Repeated embedded SVG ID');
assert.ok(html.includes("idPrefix:'live'"),'Dynamic art must have a separate ID namespace');
const report={pose_samples:samples,minimum_control_point_margin:Number(minMargin.toFixed(2)),movements,
  checks:['finite bounded part transforms','actual component alignment, not opacity-only motion','stable identity part in every direction','exact 3.2s loop seam and settle','fixed reduced-motion pose','no embedded bitmap or text in masters','unique static/dynamic SVG namespaces','offline HTML/CSP with no media or network APIs'],
  scope:'Node pose checks, HTML/source and syntax checks. Native browser controls, layout, rendering, clipping, playback and accessibility remain unverified.'};
fs.writeFileSync(path.join(__dirname,'validation.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
