/* Blue revision: original directional light-current geometry, no product bindings. */
(function(root) {
  'use strict';
  const KINDS = ['confluence', 'interval', 'wake'];
  const NAMES = {confluence:'Confluence',interval:'Open intervals',wake:'Long wake'};
  const clamp = (x,a=0,b=1) => Math.min(b,Math.max(a,Number.isFinite(x)?x:a));
  const f = x => Number(x.toFixed(4));
  const CORE = {x1:147,y1:112,x2:165,y2:91,width:12};
  const ANCHOR = {x:156,y:101.5};
  // Three distinct cubic current paths. They approach the focus from one side;
  // their centerlines, lengths and weights are not radial or rotational copies.
  const CHANNELS = [
    {points:[[62,157],[70,196],[130,188],[158,135]],width:10.5,color:'#437BFF',group:'outer'},
    {points:[[60,129],[80,157],[120,150],[139,124]],width:13,color:'#72BEFF',group:'mid'},
    {points:[[78,99],[93,116],[114,116],[130,107]],width:10,color:'#A7DFFF',group:'inner'}
  ];
  function point(curve,t) {
    const u=1-t,[a,b,c,d]=curve;
    return {x:u*u*u*a[0]+3*u*u*t*b[0]+3*u*t*t*c[0]+t*t*t*d[0],y:u*u*u*a[1]+3*u*u*t*b[1]+3*u*t*t*c[1]+t*t*t*d[1]};
  }
  function derivative(curve,t) {
    const u=1-t,[a,b,c,d]=curve;
    return {x:3*u*u*(b[0]-a[0])+6*u*t*(c[0]-b[0])+3*t*t*(d[0]-c[0]),y:3*u*u*(b[1]-a[1])+6*u*t*(c[1]-b[1])+3*t*t*(d[1]-c[1])};
  }
  function segment(curve,start,end) {
    const a=point(curve,start),d=point(curve,end),da=derivative(curve,start),dd=derivative(curve,end),h=(end-start)/3;
    return [[a.x,a.y],[a.x+da.x*h,a.y+da.y*h],[d.x-dd.x*h,d.y-dd.y*h],[d.x,d.y]];
  }
  const ease = x => {x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  const TIMING = {outer:[.04,1.04,1.35,2.69],mid:[.18,1.18,1.48,2.8],inner:[.32,1.32,1.61,2.9]};
  const CYCLE=3;
  function gather(time,group) {
    const t=((time%CYCLE)+CYCLE)%CYCLE,[a,b,c,d]=TIMING[group];
    if(t<a)return 0;
    if(t<b)return ease((t-a)/(b-a));
    if(t<c)return 1;
    if(t<d)return 1-1.025*ease((t-c)/(d-c));
    return -.025*(1-ease((t-d)/(CYCLE-d)));
  }
  function envelope(t){return clamp(Math.max(0,Math.sin(4.3*t))*(.6+.4*Math.sin(1.7*t+.4))*(.8+.2*Math.cos(12*t)));}
  function pose(kind,{state='working',time=0,amplitude=0,motion=false,phase}={}) {
    if(!KINDS.includes(kind))throw new Error('Unknown current composition');
    amplitude=clamp(amplitude);time=Math.max(0,Number.isFinite(time)?time:0);
    let breadth=1;
    if(state==='listening')breadth=motion?1+.10*amplitude:1.06;
    if(state==='speaking')breadth=motion?.94+.16*amplitude:1.04;
    const currents=CHANNELS.map((channel,i)=>{
      let c=phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,channel.group):.22):0;
      if(state==='offline')c=.45;
      const scale=(1-[.34,.26,.18][i]*c)*breadth;
      const points=channel.points.map(([x,y])=>[f(ANCHOR.x+(x-ANCHOR.x)*scale),f(ANCHOR.y+(y-ANCHOR.y)*scale)]);
      if(kind==='wake') {
        // Same family, with a longer low current and a little more directional space.
        points[0][0]-=i===0?4:0;points[0][1]+=i===0?5:0;
        points[1][1]+=i===0?3:0;
      }
      const ranges=kind==='interval'?[[.06,.28],[.43,.69],[.82,.96]]:
        kind==='wake'?[[.02,.57],[.71,.98]]:[[.02,.20],[.34,.98]];
      const pieces=ranges.map(([start,end],j)=>({
        id:`${i}-${j}`,points:segment(points,start,end).map(p=>p.map(f)),
        width:f(channel.width*(1-.14*c)*(kind==='interval'?.9:1)),
        color:channel.color,opacity:f((state==='offline'?.35:1)*(j===0?.7:1)),group:channel.group,
        scale:f(scale)
      }));
      return pieces;
    }).flat();
    // Two short cool-blue light traces follow the wake, not a surrounding constellation.
    const traces=[{x1:51,y1:151,x2:47,y2:143,width:4,color:'#3B5EC4',group:'outer'},
      {x1:61,y1:107,x2:56,y2:101,width:3.5,color:'#5A83D6',group:'mid'}].map((p,i)=>{
        const c=phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,p.group):.22):state==='offline'?.45:0;
        const s=(1-(i?.26:.34)*c)*breadth;
        const q={...p,id:`trace-${i}`,opacity:f((state==='offline'?.25:.6)*(1-.35*c))};
        for(const k of ['x1','x2'])q[k]=f(ANCHOR.x+(p[k]-ANCHOR.x)*s);
        for(const k of ['y1','y2'])q[k]=f(ANCHOR.y+(p[k]-ANCHOR.y)*s);
        q.width=f(p.width*(1-.25*c));return q;
      });
    return {kind,state,core:{...CORE},currents,traces};
  }
  const pathD = points => `M${points[0].map(f).join(' ')} C${points.slice(1).map(p=>p.map(f).join(' ')).join(' ')}`;
  const lineD = p => `M${p.x1} ${p.y1} L${p.x2} ${p.y2}`;
  function halo(d,width,color,peak=.2,extra='') {
    // Editable layered stroke halos. No gradient, raster or SVG-filter dependency.
    let s='',previous=0;
    for(let i=36;i>=1;i--){
      const t=i/36,target=peak*Math.exp(-t*t/.16),alpha=(target-previous)/(1-previous);
      s+=`<path d="${d}" fill="none" stroke="${color}" stroke-width="${f(width+t*26)}" opacity="${f(alpha)}" stroke-linecap="round"/>`;previous=target;
    }
    return `<g ${extra}>${s}</g>`;
  }
  let serial=0;
  function svg(kind,{size=256,tile=false,theme='dark',mono=false,crisp=size<=32,title=NAMES[kind],...options}={}) {
    const p=pose(kind,options),id=`blue-${++serial}`,dark=theme==='dark';
    const ink=dark?'#E6F4FF':'#14263E';
    let body=tile?`<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark?'#0A101E':'#EDF3FC'}" stroke="${dark?'#28334B':'#D2DDEC'}" stroke-width="1.1"/>`:'';
    if(!crisp&&!mono&&dark)body+=halo(lineD(CORE),CORE.width+8,'#426BE5',.1);
    for(const q of p.traces)body+=`<path data-trace="${q.id}" d="${lineD(q)}" fill="none" stroke="${mono?ink:dark?q.color:'#3865A1'}" stroke-width="${q.width}" stroke-linecap="round" opacity="${mono?1:q.opacity}"/>`;
    for(const c of p.currents) {
      const color=mono?ink:dark?c.color:({outer:'#315EC8',mid:'#276EB5',inner:'#33809F'}[c.group]);
      if(!crisp&&!mono&&dark)body+=halo(pathD(c.points),c.width,c.color,.19,`data-halo="${c.id}" opacity="${c.opacity}"`);
      body+=`<path data-current="${c.id}" d="${pathD(c.points)}" fill="none" stroke="${color}" stroke-width="${c.width}" stroke-linecap="round" opacity="${mono?1:c.opacity}"/>`;
    }
    if(!crisp&&!mono&&dark)body+=halo(lineD(CORE),CORE.width,'#A5DFFF',.58);
    body+=`<path data-core="true" d="${lineD(CORE)}" fill="none" stroke="${mono?ink:dark?'#E5F5FF':'#16365C'}" stroke-width="${CORE.width}" stroke-linecap="round"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}"><title id="${id}">${title}</title>${body}</svg>`;
  }
  function micro(kind,{size=16,theme='dark',mono=false}={}) {
    const dark=theme==='dark',ink=dark?'#E6F4FF':'#14263E',blue=mono?ink:dark?'#70BAFF':'#2868B5';
    // Deliberately different from the prior core-plus-four-dots micro mark.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="${NAMES[kind]} status mark"><g transform="translate(-3.3 -3.5) scale(1.5)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 6.7 L11 5" stroke="${ink}" stroke-width="1.7"/><path d="M4.2 9.8 C5 12.2 8.4 11.8 10 8.7" stroke="${blue}" stroke-width="1.5"/><path d="M4.1 7.5 C5.4 9.1 7.5 8.5 8.5 7.5" stroke="${blue}" stroke-width="1.4"/><path d="M5 5.6 C6 6.8 7.2 6.7 8.2 6.1" stroke="${blue}" stroke-width="1.2"/></g></svg>`;
  }
  const api={KINDS,NAMES,CORE,ANCHOR,CYCLE,TIMING,pose,svg,micro,pathD,lineD,gather,envelope,clamp};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.BlueCurrent=api;
})(typeof globalThis==='undefined'?this:globalThis);
