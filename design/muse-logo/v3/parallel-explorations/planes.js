/* Broader Parallel forms and independently selectable palettes. Editable SVG. */
(function(root){
  'use strict';
  const KINDS=['original','fan','crossing','horizon','prism','terrace'];
  const NAMES={original:'Parallel',fan:'Fan',crossing:'Crossing',horizon:'Horizon',prism:'Prism',terrace:'Terrace'};
  const PALETTES={
    blue:{name:'Blue',base:['#2356D6','#3268ED','#386EE8'],light:['#72BEFF','#72BEFF','#D8F3FF'],ice:'#E5F5FF',edge:'#DFF5FF',ambient:'#437BFF',bg:'#0A101E'},
    lagoon:{name:'Lagoon',base:['#0B5D75','#0E8E9A','#1BA799'],light:['#40C7D6','#79E3D8','#D8F9ED'],ice:'#E4FFF7',edge:'#D8FFF5',ambient:'#1BB6AB',bg:'#07191E'},
    violet:{name:'Violet',base:['#4922A7','#7646D8','#9A69E4'],light:['#9F89FF','#CAADFF','#FFE5F3'],ice:'#FFF0F8',edge:'#F2E9FF',ambient:'#9457E6',bg:'#100D20'},
    ember:{name:'Ember',base:['#8C3348','#CB5A43','#E88B52'],light:['#EC8C82','#FFBC8B','#FFE6BC'],ice:'#FFF1D6',edge:'#FFE6CC',ambient:'#F28A58',bg:'#1B1116'},
    pearl:{name:'Pearl',base:['#3D536D','#7789A4','#9BAFC5'],light:['#8CA8C6','#CAD9E8','#FCF4E9'],ice:'#FFFFFF',edge:'#EDF5FF',ambient:'#9FB9D0',bg:'#101720'},
    citrine:{name:'Citrine',base:['#3C5F35','#799B38','#A1BC4D'],light:['#A2C66D','#D4E88E','#F8F3C4'],ice:'#FFFBD9',edge:'#F4F8D8',ambient:'#C0D569',bg:'#141B10'}
  };
  const DEFAULTS={original:'blue',fan:'lagoon',crossing:'violet',horizon:'ember',prism:'pearl',terrace:'citrine'};
  const NOTES={original:'Approved direction, retained as the reference.',fan:'Three broad planes fan from a common footing.',crossing:'Independent planes cross through a shared working region.',horizon:'Wide horizontal surfaces create a new rhythm.',prism:'Three surfaces assemble into one sculptural volume.',terrace:'Offset surfaces form a spatial, stepped stack.'};
  const CYCLE=3.2;
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:a));
  const f=x=>Number(x.toFixed(4));
  const shade=(hex,amount)=>'#'+[1,3,5].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*amount).toString(16).padStart(2,'0')).join('');
  const ease=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  function rounded(vertices,radius){
    const entries=[],exits=[],n=vertices.length;
    for(let i=0;i<n;i++){
      const v=vertices[i],p=vertices[(i+n-1)%n],q=vertices[(i+1)%n],a=Math.min(radius/Math.hypot(p[0]-v[0],p[1]-v[1]),.4),b=Math.min(radius/Math.hypot(q[0]-v[0],q[1]-v[1]),.4);
      entries.push([f(v[0]+(p[0]-v[0])*a),f(v[1]+(p[1]-v[1])*a)]);exits.push([f(v[0]+(q[0]-v[0])*b),f(v[1]+(q[1]-v[1])*b)]);
    }
    let d=`M${entries[0].join(' ')}`,edge='';
    for(let i=0;i<n;i++){d+=` Q${vertices[i].join(' ')} ${exits[i].join(' ')} L${entries[(i+1)%n].join(' ')}`;if(i===0)edge=d;}
    return {d:d+'Z',edge};
  }
  function rotate(vertices,degrees,px=128,py=176){const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return vertices.map(([x,y])=>[f(px+(x-px)*c-(y-py)*s),f(py+(x-px)*s+(y-py)*c)]);}
  function face(vertices,radius=10){
    const x=vertices.reduce((s,p)=>s+p[0],0)/vertices.length,y=vertices.reduce((s,p)=>s+p[1],0)/vertices.length;
    const xs=vertices.map(p=>p[0]),ys=vertices.map(p=>p[1]),r=Math.max(Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys))*.95;
    return {...rounded(vertices,radius),x:f(x),y:f(y),r:f(r),cx:f(vertices[0][0]*.5+vertices[1][0]*.2+x*.3),cy:f(vertices[0][1]*.5+vertices[1][1]*.2+y*.3)};
  }
  const ORIGINAL=[
    {d:'M164 104 C158 100 151 104 151 112 L151 155 C151 161 153 166 159 169 L185 185 C191 189 197 185 197 178 L197 135 C197 129 194 124 189 121 Z',x:174,y:144,r:74,cx:183,cy:112,edge:'M164 104 C158 100 151 104 151 112'},
    {d:'M126 78 C119 74 112 79 112 87 L112 158 C112 166 115 173 122 177 L158 199 C165 203 172 199 172 191 L172 120 C172 111 168 104 161 100 Z',x:142,y:138,r:88,cx:143,cy:86,edge:'M126 78 C119 74 112 79 112 87'},
    {d:'M83 48 C76 44 68 49 68 58 L68 151 C68 162 71 169 80 174 L119 198 C127 203 136 198 136 188 L136 95 C136 85 132 78 123 73 Z',x:101,y:124,r:110,cx:83,cy:58,edge:'M83 48 C76 44 68 49 68 58 L68 151'}
  ];
  function forms(kind,palette=DEFAULTS[kind]){
    if(!KINDS.includes(kind)||!PALETTES[palette])throw new Error('Unknown form or palette');
    let shapes;
    if(kind==='original')shapes=ORIGINAL.map(p=>({...p}));
    if(kind==='fan'){
      const v=[[96,57],[150,73],[150,184],[96,168]];
      shapes=[face(rotate(v,25),10),face(v,10),face(rotate(v,-25),10)];
    }
    if(kind==='crossing')shapes=[face([[55,112],[147,68],[178,92],[86,139]],10),face([[84,150],[175,109],[203,135],[113,177]],10),face([[94,59],[137,83],[163,183],[120,160]],11)];
    if(kind==='horizon')shapes=[face([[72,62],[187,91],[187,120],[72,91]],10),face([[70,150],[169,175],[169,206],[70,181]],10),face([[52,104],[192,139],[192,170],[52,135]],10)];
    if(kind==='prism')shapes=[face([[133,132],[196,94],[196,170],[133,210]],9),face([[60,94],[123,132],[123,210],[60,170]],9),face([[128,48],[196,87],[128,128],[60,88]],10)];
    if(kind==='terrace')shapes=[face([[146,56],[205,87],[153,118],[93,88]],10),face([[108,93],[181,131],[117,170],[44,132]],11),face([[96,145],[166,181],[111,215],[41,178]],11)];
    return shapes.map((p,i)=>({...p,id:['background','working','foreground'][i],color:PALETTES[palette].base[i],light:PALETTES[palette].light[i]}));
  }
  function gather(time,delay=0){const t=((time%CYCLE)+CYCLE)%CYCLE,a=.08+delay,b=1.18+delay,c=1.48+delay*.5,d=2.97+delay*.3;if(t<a)return 0;if(t<b)return ease((t-a)/(b-a));if(t<c)return 1;if(t<d)return 1-1.02*ease((t-c)/(d-c));return -.02*(1-ease((t-d)/(CYCLE-d)));}
  function pose(kind,{palette=DEFAULTS[kind],state='working',time=0,motion=false,phase}={}){
    time=Math.max(0,Number.isFinite(time)?time:0);
    const parts=forms(kind,palette).map((p,i)=>{
      const c=phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,i*.09):.2):0;
      let tx=0,ty=0,scale=1;
      if(i<2){
        if(kind==='original'){tx=-(i===0?15:7)*c;ty=-(i===0?6:3)*c;}
        if(kind==='fan'){tx=(128-p.x)*.26*c;ty=(168-p.y)*.13*c;scale=1-(i===0?.025:.015)*c;}
        if(kind==='crossing'){tx=(128-p.x)*.26*c;ty=(128-p.y)*.26*c;scale=1-(i===0?.04:.025)*c;}
        if(kind==='horizon'){tx=(i===0?-2:2)*c;ty=(i===0?10:-10)*c;scale=1-.015*c;}
        if(kind==='prism'){tx=(i===0?-3:3)*c;ty=-8*c;scale=1-.015*c;}
        if(kind==='terrace'){tx=-(i===0?10:5)*c;ty=(i===0?14:7)*c;scale=1-.015*c;}
      }
      return {...p,tx:f(tx),ty:f(ty),scale:f(scale),transform:`translate(${f(tx+p.x*(1-scale))} ${f(ty+p.y*(1-scale))}) scale(${f(scale)})`};
    });return {kind,palette,state,parts};
  }
  let serial=0,lightSerial=0,scope='art';
  function glow(x,y,r,color,peak){const id=`${scope}-light-${++lightSerial}`,floor=Math.exp(-1/.3);let stops='';for(let i=0;i<=16;i++){const t=i/16,a=peak*(Math.exp(-t*t/.3)-floor)/(1-floor);stops+=`<stop offset="${t}" stop-color="${color}" stop-opacity="${f(Math.max(0,a))}"/>`;}return `<g data-glow="true" data-x="${x}" data-y="${y}" data-r="${r}" data-color="${color}" data-peak="${peak}"><defs><radialGradient id="${id}">${stops}</radialGradient></defs><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id})"/></g>`;}
  function svg(kind,{palette=DEFAULTS[kind],size=256,tile=false,theme='dark',mono=false,crisp=size<=32,state='idle',idPrefix='art',...options}={}){
    const pal=PALETTES[palette],p=pose(kind,{palette,state,...options}),dark=theme==='dark',ink=dark?'#F3F5F3':'#17252F',id=`${idPrefix}-${++serial}`;scope=id;
    let s=tile?`<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark?pal.bg:'#EDF3FC'}" stroke="${dark?'#28334B':'#D2DDEC'}" stroke-width="1.1"/>`:'';
    if(!mono&&!crisp&&dark)s+=glow(128,130,108,pal.ambient,.105);
    for(const q of p.parts){
      const cid=`${id}-${q.id}`;if(!mono)s+=`<defs><clipPath id="${cid}"><path d="${q.d}"/></clipPath></defs>`;
      s+=`<g data-layer="${q.id}" transform="${q.transform}"><path data-surface="true" d="${q.d}" fill="${mono?ink:dark?q.color:shade(q.color,.82)}"/>`;
      if(!mono){s+=`<g data-lighting="true" clip-path="url(#${cid})">`+glow(q.cx,q.cy,q.r,q.light,dark?.94:.45)+glow(q.cx+9,q.cy-6,q.r*.52,pal.ice,dark?.42:.12)+'</g>';if(q.edge&&!crisp)s+=`<path d="${q.edge}" fill="none" stroke="${pal.edge}" stroke-width=".85" opacity=".4"/>`;}
      s+='</g>';
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}"><title id="${id}">Parallel exploration — ${NAMES[kind]}, ${pal.name}</title>${s}</svg>`;
  }
  function micro(kind,{palette=DEFAULTS[kind],size=16,theme='dark',mono=false}={}){
    const parts=forms(kind,palette),xs=[],ys=[];
    for(const q of parts){const a=q.d.match(/-?\d+(?:\.\d+)?/g).map(Number);for(let i=0;i<a.length;i+=2){xs.push(a[i]);ys.push(a[i+1]);}}
    const l=Math.min(...xs),r=Math.max(...xs),t=Math.min(...ys),b=Math.max(...ys),scale=13.5/Math.max(r-l,b-t),tx=8-(l+r)/2*scale,ty=8-(t+b)/2*scale,pal=PALETTES[palette];
    let s='';for(let i=0;i<3;i++){const color=mono?(theme==='dark'?'#F3F5F3':'#17252F'):theme==='dark'?(i===2?pal.light[2]:pal.base[i]):pal.base[0];s+=`<path d="${parts[i].d}" fill="${color}"/>`;}
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="${NAMES[kind]} ${pal.name} status mark"><g transform="translate(${f(tx)} ${f(ty)}) scale(${f(scale)})">${s}</g></svg>`;
  }
  const api={KINDS,NAMES,PALETTES,DEFAULTS,NOTES,CYCLE,forms,pose,svg,micro,gather};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ParallelExplorations=api;
})(typeof globalThis==='undefined'?this:globalThis);
