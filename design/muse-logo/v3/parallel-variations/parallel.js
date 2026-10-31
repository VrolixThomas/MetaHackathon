/* Focused refinements of the user-selected Parallel mark. No product bindings. */
(function(root){
  'use strict';
  const KINDS=['original','compact','open','aligned','soft','level'];
  const NAMES={original:'Original',compact:'Compact',open:'Open',aligned:'Aligned',soft:'Rounded',level:'Level'};
  const NOTES={original:'Approved Parallel reference.',compact:'Tighter offsets; a denser, more unified silhouette.',open:'More separation; each work surface is easier to see.',aligned:'A taller rear surface brings the lower edges into alignment.',soft:'Rounder corners, with the same three-surface structure.',level:'A shallower angle; calmer, more front-facing surfaces.'};
  const CYCLE=3.2;
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:a));
  const f=x=>Number(x.toFixed(4));
  const ease=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  const BASE=[
    {id:'background',d:'M164 104 C158 100 151 104 151 112 L151 155 C151 161 153 166 159 169 L185 185 C191 189 197 185 197 178 L197 135 C197 129 194 124 189 121 Z',color:'#2356D6',x:174,y:144,r:74,light:'#72BEFF',cx:183,cy:112,edge:'M164 104 C158 100 151 104 151 112'},
    {id:'working',d:'M126 78 C119 74 112 79 112 87 L112 158 C112 166 115 173 122 177 L158 199 C165 203 172 199 172 191 L172 120 C172 111 168 104 161 100 Z',color:'#3268ED',x:142,y:138,r:88,light:'#72BEFF',cx:143,cy:86,edge:'M126 78 C119 74 112 79 112 87'},
    {id:'foreground',d:'M83 48 C76 44 68 49 68 58 L68 151 C68 162 71 169 80 174 L119 198 C127 203 136 198 136 188 L136 95 C136 85 132 78 123 73 Z',color:'#386EE8',x:101,y:124,r:110,light:'#D8F3FF',cx:83,cy:58,edge:'M83 48 C76 44 68 49 68 58 L68 151'}
  ];
  const PLANS={
    original:[{}, {}, {}],
    compact:[{dx:-13,dy:-4},{dx:-6,dy:-2},{}],
    open:[{dx:15,dy:3},{dx:7,dy:2},{}],
    aligned:[{}, {}, {}],
    soft:[{}, {}, {}],
    level:[{shear:-.22},{shear:-.22},{shear:-.22}]
  };
  function point(x,y,t={}){
    const {sx=1,sy=1,px=0,py=0,dx=0,dy=0,shear=0}=t;
    return [f(px+(x-px)*sx+dx),f(py+(y-py)*sy+shear*(x-128)+dy)];
  }
  function mapPath(d,t){let i=0,x=0;return d.replace(/-?\d+(?:\.\d+)?/g,s=>{const n=Number(s);if(i++%2===0){x=n;return String(point(n,0,t)[0]);}return String(point(x,n,t)[1]);});}
  function extendLower(d,start,end,amount){let i=0;return d.replace(/-?\d+(?:\.\d+)?/g,s=>{const n=Number(s);return String(f(i++%2===0?n:n+amount*clamp((n-start)/(end-start))));});}
  function roundedPolygon(vertices,radius){
    const n=vertices.length,entries=[],exits=[];
    for(let i=0;i<n;i++){
      const v=vertices[i],p=vertices[(i+n-1)%n],q=vertices[(i+1)%n];
      const a=Math.min(radius/Math.hypot(p[0]-v[0],p[1]-v[1]),.42),b=Math.min(radius/Math.hypot(q[0]-v[0],q[1]-v[1]),.42);
      entries.push([f(v[0]+(p[0]-v[0])*a),f(v[1]+(p[1]-v[1])*a)]);
      exits.push([f(v[0]+(q[0]-v[0])*b),f(v[1]+(q[1]-v[1])*b)]);
    }
    let d=`M${entries[0].join(' ')}`,edge='';
    for(let i=0;i<n;i++){d+=` Q${vertices[i].join(' ')} ${exits[i].join(' ')} L${entries[(i+1)%n].join(' ')}`;if(i===0)edge=d;}
    return {d:d+'Z',edge};
  }
  function forms(kind){
    if(!KINDS.includes(kind))throw new Error('Unknown Parallel variation');
    return BASE.map((base,i)=>{
      const t=PLANS[kind][i],p={...base};
      if(kind==='aligned'&&i===0){p.d=extendLower(p.d,135,155,14);p.y+=6.3;p.r*=Math.sqrt(103/89);}
      if(kind==='soft'){
        const v=i===0?[[151,96],[197,124],[197,193],[151,165]]:i===1?[[112,69],[172,106],[172,207],[112,170]]:[[68,39],[136,81],[136,207],[68,166]];
        const shape=roundedPolygon(v,[14,18,23][i]);p.d=shape.d;p.edge=shape.edge;p.cy+=6;
      }
      p.d=mapPath(p.d,t);p.edge=mapPath(p.edge,t);
      [p.x,p.y]=point(p.x,p.y,t);[p.cx,p.cy]=point(p.cx,p.cy,t);
      p.r=f(p.r*Math.sqrt((t.sx??1)*(t.sy??1)));
      return p;
    });
  }
  function gather(time,delay=0){
    const t=((time%CYCLE)+CYCLE)%CYCLE,a=.08+delay,b=1.18+delay,c=1.48+delay*.5,d=2.97+delay*.3;
    if(t<a)return 0;if(t<b)return ease((t-a)/(b-a));if(t<c)return 1;
    if(t<d)return 1-1.02*ease((t-c)/(d-c));return -.02*(1-ease((t-d)/(CYCLE-d)));
  }
  const TRAVEL={original:[15,7,6,3],compact:[8,4,3,1.5],open:[22,10,7,3.5],aligned:[15,7,5,2.5],soft:[13,6,5,2.5],level:[15,7,3,1.5]};
  function pose(kind,{time=0,state='working',motion=false,phase}={}){
    time=Math.max(0,Number.isFinite(time)?time:0);
    const parts=forms(kind).map((p,i)=>{
      const c=phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,i*.09):.2):0;
      const travel=TRAVEL[kind],tx=-(i===0?travel[0]:i===1?travel[1]:0)*c,ty=-(i===0?travel[2]:i===1?travel[3]:0)*c;
      return {...p,tx:f(tx),ty:f(ty),scale:1,transform:`translate(${f(tx)} ${f(ty)}) scale(1)`};
    });
    return {kind,state,parts};
  }
  let lightSerial=0,lightScope='parallel',serial=0;
  function glow(x,y,r,color,peak){
    const id=`${lightScope}-light-${++lightSerial}`,floor=Math.exp(-1/.3);let stops='';
    for(let i=0;i<=16;i++){const t=i/16,a=peak*(Math.exp(-t*t/.3)-floor)/(1-floor);stops+=`<stop offset="${t}" stop-color="${color}" stop-opacity="${f(Math.max(0,a))}"/>`;}
    return `<g data-glow="true" data-x="${x}" data-y="${y}" data-r="${r}" data-color="${color}" data-peak="${peak}"><defs><radialGradient id="${id}">${stops}</radialGradient></defs><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id})"/></g>`;
  }
  function svg(kind,{size=256,tile=false,theme='dark',mono=false,crisp=size<=32,state='idle',idPrefix='art',...options}={}){
    const p=pose(kind,{state,...options}),id=`${idPrefix}-${++serial}`,dark=theme==='dark',ink=dark?'#E6F4FF':'#14263E';lightScope=id;
    let s=tile?`<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark?'#0A101E':'#EDF3FC'}" stroke="${dark?'#28334B':'#D2DDEC'}" stroke-width="1.1"/>`:'';
    if(!crisp&&!mono&&dark)s+=glow(128,130,108,'#437BFF',.105);
    for(const q of p.parts){
      const cid=`${id}-${q.id}`;if(!mono)s+=`<defs><clipPath id="${cid}"><path d="${q.d}"/></clipPath></defs>`;
      s+=`<g data-layer="${q.id}" transform="${q.transform}"><path data-surface="true" d="${q.d}" fill="${mono?ink:q.color}"/>`;
      if(!mono){s+=`<g data-lighting="true" clip-path="url(#${cid})">`+glow(q.cx,q.cy,q.r,q.light,dark?.94:.65)+glow(q.cx+9,q.cy-6,q.r*.52,'#E5F5FF',dark?.42:.18)+'</g>';if(q.edge&&!crisp)s+=`<path d="${q.edge}" fill="none" stroke="#DFF5FF" stroke-width=".85" opacity=".4"/>`;}
      s+='</g>';
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}"><title id="${id}">Parallel — ${NAMES[kind]}</title>${s}</svg>`;
  }
  const MICRO=[
    {d:'M12.8 6.9 L14.4 7.9 Q15 8.2 15 9 L15 12.4 L12.8 11Z',color:'back'},
    {d:'M9.2 4.6 L11 5.7 Q11.6 6.1 11.6 7 L11.6 13.7 L9.2 12.2Z',color:'back'},
    {d:'M2 2 Q2 1 3 1.5 L7.4 4.2 Q8 4.7 8 5.7 L8 14.5 Q8 15.5 7 14.9 L2.7 12.3 Q2 11.9 2 10.7Z',color:'front'}
  ];
  function micro(kind,{size=16,theme='dark',mono=false}={}){
    if(!KINDS.includes(kind))throw new Error('Unknown Parallel variation');
    const dark=theme==='dark',a=mono?(dark?'#E6F4FF':'#14263E'):(dark?'#8DD1FF':'#2868B5'),b=mono?a:(dark?'#437BFF':'#315ABD');
    const plans=kind==='compact'?[{dx:-.9},{dx:-.45},{}]:kind==='open'?[{dx:.15},{dx:.15},{sx:.95,px:2}]:[{},{},{}];
    let s='';
    for(let i=0;i<3;i++){
      let d=MICRO[i].d;
      if(kind==='aligned'&&i<2)d=extendLower(d,i===0?9:7,i===0?11:12.2,i===0?2.5:1.2);
      if(kind==='soft'){
        const v=i===0?[[12.8,6.5],[15,7.9],[15,12.8],[12.8,11.4]]:i===1?[[9.2,4.5],[11.6,6],[11.6,14],[9.2,12.5]]:[[2,1],[8,4.6],[8,15.5],[2,11.8]];
        d=roundedPolygon(v,[.45,.6,1.15][i]).d;
      }
      d=mapPath(d,plans[i]);
      if(kind==='level'){let j=0,x=0;d=d.replace(/-?\d+(?:\.\d+)?/g,v=>{const n=Number(v);if(j++%2===0){x=n;return String(n);}return String(f(n-.22*(x-8)));});}
      s+=`<path d="${d}" fill="${i===2?a:b}"/>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="Parallel ${NAMES[kind]} status mark">${s}</svg>`;
  }
  const api={KINDS,NAMES,NOTES,CYCLE,forms,pose,svg,micro,gather,clamp};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ParallelVariations=api;
})(typeof globalThis==='undefined'?this:globalThis);
