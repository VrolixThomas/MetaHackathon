/* Many threads, one shared focus. Original editable geometry and motion. */
(function(root){
  'use strict';
  const CYCLE=3.2,FOCUS={x:165,y:92,rx:10.5,ry:9.5};
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:a));
  const f=x=>Number(x.toFixed(4));
  const ease=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  function smooth(points){
    const n=points.length;let d=`M${points[0].map(f).join(' ')}`;
    for(let i=0;i<n;i++){const a=points[(i+n-1)%n],b=points[i],c=points[(i+1)%n],e=points[(i+2)%n];d+=` C${[b[0]+(c[0]-a[0])/6,b[1]+(c[1]-a[1])/6,c[0]-(e[0]-b[0])/6,c[1]-(e[1]-b[1])/6,c[0],c[1]].map(f).join(' ')}`;}
    return d+' Z';
  }
  function gather(time,delay=0){
    const t=((time%CYCLE)+CYCLE)%CYCLE,a=.04+delay,b=1.14+delay,c=1.46+delay*.5,d=2.94+delay*.35;
    if(t<a)return 0;if(t<b)return ease((t-a)/(b-a));if(t<c)return 1;
    if(t<d)return 1-1.02*ease((t-c)/(d-c));return -.02*(1-ease((t-d)/(CYCLE-d)));
  }
  function shape(scale,width){
    // The circle opens toward the shared-focus junction; contour and width are unequal.
    const a=-22*Math.PI/180,b=289*Math.PI/180,outer=[],inner=[];
    const radial=(t,isOuter)=>{
      const r=isOuter?63+3.1*Math.sin(t+.4)+2.1*Math.sin(3*t+.8):36+3.6*Math.sin(2*t+.6)+1.3*Math.cos(3*t);
      return [128+Math.cos(t)*(r+(isOuter?width:-width)),128+Math.sin(t)*(r+(isOuter?width:-width))*.97];
    };
    for(let j=0;j<=64;j++){const t=a+(b-a)*j/64;outer.push(radial(t,true));inner.push(radial(t,false));}
    const points=outer.slice();
    const cap=(t,begin)=>{
      const o=radial(t,true),n=radial(t,false),c=[(o[0]+n[0])/2,(o[1]+n[1])/2],half=Math.hypot(o[0]-n[0],o[1]-n[1])/2;
      const u=[Math.cos(t),Math.sin(t)],v=[-Math.sin(t),Math.cos(t)];
      for(let j=1;j<8;j++){const p=begin+Math.PI*j/8;points.push([c[0]+half*(u[0]*Math.cos(p)+v[0]*Math.sin(p)),c[1]+half*(u[1]*Math.cos(p)+v[1]*Math.sin(p))]);}
    };
    cap(b,0);points.push(...inner.reverse());cap(a,Math.PI);
    return points.map(([x,y])=>[f(FOCUS.x+(x-FOCUS.x)*scale),f(FOCUS.y+(y-FOCUS.y)*scale)]);
  }
  const SIGNALS=[
    {from:[77,65],via:[83,91],to:[111,91],r:4,color:'#A7DFFF',delay:0},
    {from:[48,130],via:[75,111],to:[87,132],r:5,color:'#72BEFF',delay:.12},
    {from:[80,191],via:[116,193],to:[119,166],r:3.4,color:'#437BFF',delay:.24}
  ];
  function pose({state='working',time=0,motion=false,amplitude=0,phase}={}){
    time=Math.max(0,Number.isFinite(time)?time:0);amplitude=clamp(amplitude);
    const c=delay=>phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,delay):.18):state==='offline'?.45:0;
    const breadth=state==='listening'?(motion?1+.07*amplitude:1.04):state==='speaking'?(motion?.96+.11*amplitude:1.02):1;
    const scale=(1-.13*c(.14))*breadth,width=1.6*c(.23);
    const points=shape(scale,width),signals=SIGNALS.map((p,i)=>{
      const t=clamp(c(p.delay)),u=1-t;
      const x=u*u*p.from[0]+2*u*t*p.via[0]+t*t*p.to[0],y=u*u*p.from[1]+2*u*t*p.via[1]+t*t*p.to[1];
      const q=[u*p.via[0]+t*p.to[0],u*p.via[1]+t*p.to[1]];
      return {id:i,x:f(x),y:f(y),r:f(p.r*(1-.24*t)),opacity:f((state==='offline'?.3:1)*(1-.22*t)),color:p.color,progress:f(t),
        threadD:`M${f(x)} ${f(y)} Q${q.map(f).join(' ')} ${p.to.map(f).join(' ')}`,threadOpacity:f((state==='offline'?.1:.25)*(1-.8*t))};
    });
    const lightScale=f(1-.1*c(.2));
    return {state,focus:{...FOCUS},points,d:smooth(points),signals,bodyScale:f(scale),lightScale,
      lightTransform:`translate(${FOCUS.x} ${FOCUS.y}) scale(${lightScale}) translate(${-FOCUS.x} ${-FOCUS.y})`,opacity:state==='offline'?.38:1};
  }
  function glow(x,y,r,color,peak,steps=48){
    let s='',previous=0;
    for(let i=steps;i>=1;i--){const t=i/steps,target=peak*Math.exp(-t*t/.24),alpha=(target-previous)/(1-previous);s+=`<circle cx="${x}" cy="${y}" r="${f(t*r)}" fill="${color}" opacity="${f(alpha)}"/>`;previous=target;}
    return s;
  }
  function envelope(t){return clamp(Math.max(0,Math.sin(t*4.2))*(.6+.4*Math.sin(t*1.8+.5))*(.8+.2*Math.cos(t*13)));}
  let serial=0;
  function svg({size=256,tile=false,theme='dark',mono=false,crisp=size<=32,state='idle',...options}={}){
    const P=pose({state,...options}),dark=theme==='dark',ink=dark?'#E6F4FF':'#14263E',id=`focus-${++serial}`;
    let s=tile?`<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark?'#0A101E':'#EDF3FC'}" stroke="${dark?'#28334B':'#D2DDEC'}" stroke-width="1.1"/>`:'';
    if(!crisp&&!mono&&dark)s+=glow(130,125,103,'#437BFF',.13);
    for(const p of P.signals){
      if(!crisp)s+=`<path data-thread="${p.id}" d="${p.threadD}" fill="none" stroke="${mono?ink:dark?p.color:'#2868B5'}" stroke-width="1.35" stroke-linecap="round" opacity="${p.threadOpacity}"/>`;
      if(!crisp&&!mono&&dark)s+=`<g data-signal-halo="${p.id}" transform="translate(${p.x} ${p.y}) scale(${f(p.r*3)})" opacity="${p.opacity}">${glow(0,0,1,p.color,.28,24)}</g>`;
      s+=`<circle data-signal="${p.id}" cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${mono?ink:dark?p.color:['#3874B8','#2868B5','#315ABD'][p.id]}" opacity="${p.opacity}"/>`;
    }
    if(!mono)s+=`<defs><clipPath id="${id}-clip"><path data-contour="true" d="${P.d}"/></clipPath></defs>`;
    s+=`<g data-field="true" opacity="${P.opacity}"><path data-contour="true" d="${P.d}" fill="${mono?ink:dark?'#437BFF':'#315EC0'}"/>`;
    if(!mono){
      s+=`<g clip-path="url(#${id}-clip)"><g data-lights="true" transform="${P.lightTransform}">`;
      s+=glow(169,140,102,dark?'#72BEFF':'#4A91CC',.94)+glow(148,76,88,dark?'#A7DFFF':'#78B8DD',.98)+glow(161,79,48,dark?'#E5F5FF':'#A1D1E9',.72);
      s+='</g></g>';
    }
    s+='</g>';
    s+=`<g data-overlay="true">`;
    if(!crisp&&!mono&&dark)s+=glow(FOCUS.x,FOCUS.y,30,'#A7DFFF',.65);
    s+=`<ellipse data-focus="true" cx="${FOCUS.x}" cy="${FOCUS.y}" rx="${FOCUS.rx}" ry="${FOCUS.ry}" fill="${mono?ink:dark?'#E5F5FF':'#16365C'}"/></g>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}"><title id="${id}">Shared focus — context and independent threads</title>${s}</svg>`;
  }
  function micro({size=16,theme='dark',mono=false}={}){
    const P=pose({state:'idle'}),dark=theme==='dark',blue=mono?(dark?'#E6F4FF':'#14263E'):(dark?'#72BEFF':'#2868B5'),ice=mono?blue:(dark?'#E5F5FF':'#16365C');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="Shared focus status mark"><path d="${P.d}" transform="translate(-4.8 -4.8) scale(.1)" fill="${blue}"/><ellipse cx="11.7" cy="4.4" rx="1.1" ry="1" fill="${ice}"/></svg>`;
  }
  const api={CYCLE,FOCUS,pose,svg,micro,gather,envelope,clamp};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.SharedFocus=api;
})(typeof globalThis==='undefined'?this:globalThis);
