/* Fresh vector reset: directional fragments, shared planes, parallel surfaces. */
(function(root){
  'use strict';
  const KINDS=['relay','synthesis','parallel'];
  const NAMES={relay:'Relay',synthesis:'Synthesis',parallel:'Parallel'};
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:a));
  const f=x=>Number(x.toFixed(4));
  const ease=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  const CYCLE=3.2;
  const FORMS={
    relay:[
      {id:'intent',d:'M88 65 C92 52 104 49 116 57 L180 103 C195 113 194 124 179 131 L73 177 C59 183 53 175 59 159 Z',color:'#437BFF',x:125,y:113,r:94,light:'#A7DFFF',cx:160,cy:92,edge:'M88 65 C92 52 104 49 116 57 L180 103'},
      {id:'action',d:'M114 165 L181 139 C192 135 198 142 193 154 L169 195 C165 204 154 205 145 199 L110 181 C101 176 104 169 114 165 Z',color:'#2864E4',x:157,y:172,r:62,light:'#A7DFFF',cx:133,cy:167,edge:'M114 165 L181 139'}
    ],
    synthesis:[
      {id:'work',d:'M117 108 C124 103 132 103 139 108 L192 147 C204 156 204 168 192 176 L139 215 C132 220 124 220 117 215 L64 176 C52 168 52 156 64 147 Z',color:'#254AE0',x:128,y:162,r:98,light:'#72BEFF',cx:155,cy:147,edge:'M64 147 L117 108 C124 103 132 103 139 108 L192 147'},
      {id:'context',d:'M117 48 C124 43 132 43 139 48 L192 87 C204 96 204 108 192 116 L139 155 C132 160 124 160 117 155 L64 116 C52 108 52 96 64 87 Z',color:'#478FFF',x:128,y:101,r:98,light:'#C5ECFF',cx:150,cy:65,edge:'M64 87 L117 48 C124 43 132 43 139 48 L192 87'},
      {id:'shared',d:'M119 114 C124 110 132 110 137 114 L153 126 C159 130 159 134 153 138 L137 150 C132 154 124 154 119 150 L103 138 C97 134 97 130 103 126 Z',color:'#75BCFF',x:128,y:132,r:54,light:'#BCEBFF',cx:124,cy:118,edge:''}
    ],
    parallel:[
      {id:'background',d:'M164 104 C158 100 151 104 151 112 L151 155 C151 161 153 166 159 169 L185 185 C191 189 197 185 197 178 L197 135 C197 129 194 124 189 121 Z',color:'#2356D6',x:174,y:144,r:74,light:'#72BEFF',cx:183,cy:112,edge:'M164 104 C158 100 151 104 151 112'},
      {id:'working',d:'M126 78 C119 74 112 79 112 87 L112 158 C112 166 115 173 122 177 L158 199 C165 203 172 199 172 191 L172 120 C172 111 168 104 161 100 Z',color:'#3268ED',x:142,y:138,r:88,light:'#72BEFF',cx:143,cy:86,edge:'M126 78 C119 74 112 79 112 87'},
      {id:'foreground',d:'M83 48 C76 44 68 49 68 58 L68 151 C68 162 71 169 80 174 L119 198 C127 203 136 198 136 188 L136 95 C136 85 132 78 123 73 Z',color:'#386EE8',x:101,y:124,r:110,light:'#D8F3FF',cx:83,cy:58,edge:'M83 48 C76 44 68 49 68 58 L68 151'}
    ]
  };
  function gather(t,delay){
    t=((t%CYCLE)+CYCLE)%CYCLE;
    const a=.08+delay,b=1.18+delay,c=1.48+delay*.5,d=2.97+delay*.3;
    if(t<a)return 0;if(t<b)return ease((t-a)/(b-a));if(t<c)return 1;
    if(t<d)return 1-1.02*ease((t-c)/(d-c));return -.02*(1-ease((t-d)/(CYCLE-d)));
  }
  function pose(kind,{time=0,motion=false,phase,amplitude=0,state='working'}={}){
    if(!KINDS.includes(kind))throw new Error('Unknown reset direction');
    time=Math.max(0,Number.isFinite(time)?time:0);amplitude=clamp(amplitude);
    const base=phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,0):.2):0;
    const breadth=['speaking','listening'].includes(state)?(motion?.97+.1*amplitude:1.02):1;
    const parts=FORMS[kind].map((p,i)=>{
      const c=phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,i*.09):base):0;
      let tx=0,ty=0,scale=1;
      if(kind==='relay'){
        if(i===1){tx=3-6*c;ty=5-10*c;scale=1-.03*c;}
        // Main intent piece stays stable. The execution piece draws into alignment.
      }else if(kind==='synthesis'){
        ty=i===0?-9*c:i===1?9*c:0;
      }else{
        tx=(i===0?-15:i===1?-7:0)*c;ty=(i===0?-6:i===1?-3:0)*c;
      }
      scale*=breadth;
      const transform=`translate(${f(tx+p.x*(1-scale))} ${f(ty+p.y*(1-scale))}) scale(${f(scale)})`;
      return {...p,tx:f(tx),ty:f(ty),scale:f(scale),transform};
    });
    return {kind,state,parts};
  }
  let lightSerial=0,lightScope='art';
  function glow(x,y,r,color,peak){
    const id=`${lightScope}-light-${++lightSerial}`,floor=Math.exp(-1/.3);
    let stops='';for(let i=0;i<=16;i++){const t=i/16,a=peak*(Math.exp(-t*t/.3)-floor)/(1-floor);stops+=`<stop offset="${t}" stop-color="${color}" stop-opacity="${f(Math.max(0,a))}"/>`;}
    return `<g data-glow="true" data-x="${x}" data-y="${y}" data-r="${r}" data-color="${color}" data-peak="${peak}"><defs><radialGradient id="${id}">${stops}</radialGradient></defs><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id})"/></g>`;
  }
  let serial=0;
  function svg(kind,{size=256,tile=false,theme='dark',mono=false,crisp=size<=32,state='idle',idPrefix='art',...options}={}){
    const p=pose(kind,{state,...options}),id=`${idPrefix}-${++serial}`,dark=theme==='dark',ink=dark?'#E6F4FF':'#14263E';
    lightScope=id;
    let s=tile?`<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark?'#0A101E':'#EDF3FC'}" stroke="${dark?'#28334B':'#D2DDEC'}" stroke-width="1.1"/>`:'';
    if(!crisp&&!mono&&dark)s+=glow(128,130,108,'#437BFF',.105);
    for(const q of p.parts){
      const cid=`${id}-${q.id}`;
      if(!mono)s+=`<defs><clipPath id="${cid}"><path d="${q.d}"/></clipPath></defs>`;
      s+=`<g data-layer="${q.id}" transform="${q.transform}"><path data-surface="true" d="${q.d}" fill="${mono?ink:q.color}"/>`;
      if(!mono){
        s+=`<g data-lighting="true" clip-path="url(#${cid})">`;
        s+=glow(q.cx,q.cy,q.r,q.light,dark?.94:.65)+glow(q.cx+9,q.cy-6,q.r*.52,'#E5F5FF',dark?.42:.18);
        s+='</g>';
        if(q.edge&&!crisp)s+=`<path d="${q.edge}" fill="none" stroke="#DFF5FF" stroke-width=".85" opacity=".4"/>`;
      }
      s+='</g>';
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}"><title id="${id}">${NAMES[kind]} — fresh blue identity direction</title>${s}</svg>`;
  }
  function micro(kind,{size=16,theme='dark',mono=false}={}){
    const dark=theme==='dark',a=mono?(dark?'#E6F4FF':'#14263E'):(dark?'#8DD1FF':'#2868B5'),b=mono?a:(dark?'#437BFF':'#315ABD');
    const paths=kind==='relay'?[
      `<path d="M5.7 2.7 Q6 1.8 6.8 2.4 L12.8 6.4 Q13.7 7 12.6 7.5 L3 11.6 Q2 12 2.5 10.8Z" fill="${a}"/>`,
      `<path d="M7.1 12.1 L13.4 9.6 Q14.2 9.3 13.9 10.2 L11.9 14.1 Q11.6 14.8 10.8 14.4 L7 12.9 Q6.2 12.5 7.1 12.1Z" fill="${b}"/>`
    ]:kind==='synthesis'?[
      `<path d="M8 1.5 L14 6 Q14.8 6.6 14 7.2 L8 11.5 L2 7.2 Q1.2 6.6 2 6Z" fill="${a}"/>`,
      `<path d="M2.5 9.5 L8 13.4 L13.5 9.5 L14.1 10 Q14.8 10.5 14 11.1 L8 15 L2 11.1 Q1.2 10.5 1.9 10Z" fill="${b}"/>`
    ]:[
      `<path d="M2 2 Q2 1 3 1.5 L7.4 4.2 Q8 4.7 8 5.7 L8 14.5 Q8 15.5 7 14.9 L2.7 12.3 Q2 11.9 2 10.7Z" fill="${a}"/>`,
      `<path d="M9.2 4.6 L11 5.7 Q11.6 6.1 11.6 7 L11.6 13.7 L9.2 12.2Z M12.8 6.9 L14.4 7.9 Q15 8.2 15 9 L15 12.4 L12.8 11Z" fill="${b}"/>`
    ];
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="${NAMES[kind]} status mark">${paths.join('')}</svg>`;
  }
  const api={KINDS,NAMES,CYCLE,pose,svg,micro,gather,clamp};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.ResetMarks=api;
})(typeof globalThis==='undefined'?this:globalThis);
