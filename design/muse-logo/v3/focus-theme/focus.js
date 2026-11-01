/* Many work items remain active. One occupies the foreground for review. */
(function(root){
  'use strict';
  const KINDS=['plane','pull','stage'];
  const NAMES={plane:'Focus plane',pull:'Pull forward',stage:'Focus stage'};
  const NOTES={plane:'One broad review surface holds the foreground; two quieter work surfaces remain behind.',pull:'One item separates from a working fan and comes forward for review.',stage:'One clear surface is elevated above a quieter stack of ongoing work.'};
  const PALETTES={
    blue:{name:'Blue / Ice',far:'#142C50',near:'#285080',active:'#4B8FE9',light:'#E0F4FF',ice:'#F4FBFF',ambient:'#437BFF',bg:'#0A101E'},
    lagoon:{name:'Lagoon',far:'#123A43',near:'#216A70',active:'#29AAA3',light:'#DEFFF2',ice:'#F1FFF9',ambient:'#27B5A7',bg:'#07181E'},
    pearl:{name:'Pearl',far:'#243343',near:'#425970',active:'#91A9C3',light:'#FCF4E7',ice:'#FFFFFF',ambient:'#8BAFD0',bg:'#101720'}
  };
  // Slot 0 is the single focus position; slots 1 and 2 continue behind it.
  const SLOTS={
    plane:[[[66,57],[162,80],[162,203],[66,179]],[[112,73],[186,91],[186,190],[112,172]],[[155,95],[207,108],[207,178],[155,165]]],
    pull:[[[62,95],[151,75],[175,180],[86,200]],[[102,54],[160,72],[160,173],[102,155]],[[150,75],[202,111],[179,186],[127,151]]],
    stage:[[[64,72],[184,100],[184,171],[64,143]],[[75,121],[184,147],[184,196],[75,170]],[[91,164],[177,184],[177,215],[91,195]]]
  };
  const STEP=3.2,HOLD=2.4,SWAP=.8,TOUR=9.6;
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:a));
  const f=x=>Number(x.toFixed(4));
  const shade=(hex,amount)=>'#'+[1,3,5].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*amount).toString(16).padStart(2,'0')).join('');
  const ease=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  const mod=(x,n)=>((x%n)+n)%n;
  function wrap(t,d){const r=mod(t,d);return r<1e-8||d-r<1e-8?0:r;}
  const mix=(a,b,t)=>a+(b-a)*t;
  function color(a,b,t){return '#'+[1,3,5].map(i=>Math.round(mix(parseInt(a.slice(i,i+2),16),parseInt(b.slice(i,i+2),16),clamp(t))).toString(16).padStart(2,'0')).join('');}
  function rounded(vertices,radius){
    const entries=[],exits=[],n=vertices.length;
    for(let i=0;i<n;i++){const v=vertices[i],p=vertices[(i+n-1)%n],q=vertices[(i+1)%n],a=Math.min(radius/Math.hypot(p[0]-v[0],p[1]-v[1]),.4),b=Math.min(radius/Math.hypot(q[0]-v[0],q[1]-v[1]),.4);entries.push([f(v[0]+(p[0]-v[0])*a),f(v[1]+(p[1]-v[1])*a)]);exits.push([f(v[0]+(q[0]-v[0])*b),f(v[1]+(q[1]-v[1])*b)]);}
    let d=`M${entries[0].join(' ')}`,edge='';for(let i=0;i<n;i++){d+=` Q${vertices[i].join(' ')} ${exits[i].join(' ')} L${entries[(i+1)%n].join(' ')}`;if(i===0)edge=d;}return {d:d+'Z',edge};
  }
  function face(vertices,radius){
    const x=vertices.reduce((s,p)=>s+p[0],0)/4,y=vertices.reduce((s,p)=>s+p[1],0)/4,xs=vertices.map(p=>p[0]),ys=vertices.map(p=>p[1]);
    return {...rounded(vertices,radius),x:f(x),y:f(y),r:f(Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))*.95),cx:f(vertices[0][0]*.4+vertices[1][0]*.15+x*.45),cy:f(vertices[0][1]*.4+vertices[1][1]*.15+y*.45)};
  }
  function work(time,delay){const t=wrap(time,STEP),a=.08+delay,b=1.18+delay,c=1.48+delay*.5,d=2.97+delay*.3;if(t<a)return 0;if(t<b)return ease((t-a)/(b-a));if(t<c)return 1;if(t<d)return 1-1.015*ease((t-c)/(d-c));return -.015*(1-ease((t-d)/(STEP-d)));}
  function drift(slot,time,motion){if(!motion||slot===0)return {x:0,y:0,scale:1};const w=work(time,slot*.1);return{x:-(slot===1?1.2:2.2)*w,y:-(slot===1?.5:.8)*w,scale:1-(slot===1?.005:.009)*w};}
  function tour(time){const t=wrap(Math.max(0,Number.isFinite(time)?time:0),TOUR),focusIndex=Math.min(2,Math.floor(t/STEP)),local=t-focusIndex*STEP;return {focusIndex,transition:clamp((local-HOLD)/SWAP)};}
  function pose(kind,{palette='blue',focusIndex=0,transition=0,time=0,motion=false,auto=false,background=true}={}){
    if(!KINDS.includes(kind)||!PALETTES[palette])throw new Error('Unknown focus layout or palette');
    time=Math.max(0,Number.isFinite(time)?time:0);if(auto&&motion)({focusIndex,transition}=tour(time));
    focusIndex=mod(Math.round(Number.isFinite(focusIndex)?focusIndex:0),3);transition=clamp(transition);const p=ease(transition),nextIndex=mod(focusIndex+1,3),pal=PALETTES[palette];
    const parts=[0,1,2].map(item=>{
      const slot=mod(item-focusIndex,3),target=[2,0,1][slot],a=SLOTS[kind][slot],b=SLOTS[kind][target],da=drift(slot,time,motion&&background),db=drift(target,time,motion&&background);
      let vertices=a.map((v,i)=>[mix(v[0],b[i][0],p),mix(v[1],b[i][1],p)]);
      const arc=Math.sin(Math.PI*p);
      const cx=vertices.reduce((s,v)=>s+v[0],0)/4,cy=vertices.reduce((s,v)=>s+v[1],0)/4,scale=mix(da.scale,db.scale,p),dx=mix(da.x,db.x,p)+[ -32,12,4 ][slot]*arc,dy=mix(da.y,db.y,p)+[3,-5,2][slot]*arc;
      vertices=vertices.map(([x,y])=>[f(cx+(x-cx)*scale+dx),f(cy+(y-cy)*scale+dy)]);
      // Old focus recedes before the next becomes fully clear: never two highlighted items.
      const weight=slot===0?1-ease(p/.35):slot===1?ease((p-.65)/.35):0,depth=mix(slot,target,p);
      const dim=color(pal.near,pal.far,clamp(depth/2));
      return {...face(vertices,mix([12,10,9][slot],[12,10,9][target],p)),vertices,id:`item-${item}`,item,slot,target,depth:f(depth),emphasis:f(weight),color:color(dim,pal.active,weight),primaryPeak:f(.2+.74*weight),secondaryPeak:f(.04+.38*weight),edgeOpacity:f(.08+.32*weight),transform:'translate(0 0) scale(1)'};
    }).sort((a,b)=>b.depth-a.depth||a.item-b.item);
    return {kind,palette,focusIndex,nextIndex,transition,shownIndex:p<.5?focusIndex:nextIndex,parts};
  }
  let serial=0,lightSerial=0,scope='art';
  function glow(x,y,r,fill,peak,extra=''){
    const id=`${scope}-light-${++lightSerial}`,floor=Math.exp(-1/.3);let stops='';
    for(let i=0;i<=16;i++){const t=i/16,falloff=Math.max(0,(Math.exp(-t*t/.3)-floor)/(1-floor));stops+=`<stop data-falloff="${falloff}" offset="${t}" stop-color="${fill}" stop-opacity="${f(falloff*peak)}"/>`;}
    return `<g data-glow="true" data-x="${x}" data-y="${y}" data-r="${r}" data-color="${fill}" data-peak="${peak}" ${extra}><defs><radialGradient id="${id}">${stops}</radialGradient></defs><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id})"/></g>`;
  }
  function svg(kind,{palette='blue',size=256,tile=false,theme='dark',mono=false,crisp=size<=32,idPrefix='art',...options}={}){
    const P=pose(kind,{palette,...options}),pal=PALETTES[palette],dark=theme==='dark',ink=dark?'#EDF7FF':'#172B3C',id=`${idPrefix}-${++serial}`;scope=id;
    let s=tile?`<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark?pal.bg:'#EDF3F7'}" stroke="${dark?'#283647':'#D2DDE5'}" stroke-width="1.1"/>`:'';
    if(!mono&&!crisp&&dark)s+=glow(126,132,105,pal.ambient,.08);
    for(const q of P.parts){
      const cid=`${id}-${q.id}`;if(!mono)s+=`<defs><clipPath id="${cid}"><path data-clip-item="${q.id}" d="${q.d}"/></clipPath></defs>`;
      s+=`<g data-layer="${q.id}" transform="${q.transform}"><path data-surface="true" d="${q.d}" fill="${mono?(q.emphasis>.5?ink:'none'):dark?q.color:shade(q.color,.84)}"${mono&&q.emphasis<=.5?` stroke="${ink}" stroke-width="3"`:''}/>`;
      if(!mono){s+=`<g data-lighting="true" clip-path="url(#${cid})">`+glow(q.cx,q.cy,q.r,pal.light,q.primaryPeak*(dark?1:.55),`data-item-light="${q.id}" data-channel="primary"`)+glow(q.cx+9,q.cy-6,q.r*.52,pal.ice,q.secondaryPeak*(dark?1:.35),`data-item-light="${q.id}" data-channel="secondary"`)+`</g><path data-edge="true" d="${q.edge}" fill="none" stroke="${pal.ice}" stroke-width=".85" opacity="${q.edgeOpacity}"/>`;}
      s+='</g>';
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}"><title id="${id}">${NAMES[kind]} — one item in focus, background work continues</title>${s}</svg>`;
  }
  function micro(kind,{size=16,theme='dark',mono=false,palette='blue'}={}){
    const p=pose(kind,{palette}),xs=[],ys=[];for(const q of p.parts){const a=q.d.match(/-?\d+(?:\.\d+)?/g).map(Number);for(let i=0;i<a.length;i+=2){xs.push(a[i]);ys.push(a[i+1]);}}
    const l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...ys),b=Math.max(...ys),sc=13.5/Math.max(r-l,b-t),tx=8-(l+r)*sc/2,ty=8-(t+b)*sc/2,pal=PALETTES[palette],ink=theme==='dark'?'#EDF7FF':'#172B3C';let s='';
    for(const q of p.parts){const active=q.emphasis>.5,fill=mono?(active?ink:'none'):active?(theme==='dark'?pal.light:shade(pal.active,.8)):(theme==='dark'?pal.near:'none');s+=`<path d="${q.d}" fill="${fill}"${!active?` stroke="${mono?ink:pal.near}" stroke-width="${f(.8/sc)}"`:''}/>`;}
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="${NAMES[kind]} status mark"><g transform="translate(${f(tx)} ${f(ty)}) scale(${f(sc)})">${s}</g></svg>`;
  }
  const api={KINDS,NAMES,NOTES,PALETTES,STEP,HOLD,SWAP,TOUR,pose,tour,svg,micro,ease};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FocusTheme=api;
})(typeof globalThis==='undefined'?this:globalThis);
