/* Original organic field geometry. Standalone design model; no product bindings. */
(function(root){
  'use strict';
  const KINDS=['bloom','open','full'];
  const NAMES={bloom:'Fluid field',open:'Open field',full:'Full field'};
  const CYCLE=3.2;
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,Number.isFinite(x)?x:a));
  const f=x=>Number(x.toFixed(4));
  const ease=x=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
  function smooth(points){
    const n=points.length;
    let d=`M${points[0].map(f).join(' ')}`;
    for(let i=0;i<n;i++){
      const a=points[(i+n-1)%n],b=points[i],c=points[(i+1)%n],e=points[(i+2)%n];
      d+=` C${[b[0]+(c[0]-a[0])/6,b[1]+(c[1]-a[1])/6,c[0]-(e[0]-b[0])/6,c[1]-(e[1]-b[1])/6,c[0],c[1]].map(f).join(' ')}`;
    }
    return d+' Z';
  }
  function gather(t,delay=0){
    t=((t%CYCLE)+CYCLE)%CYCLE;
    const a=.08+delay,b=1.2+delay,c=1.5+delay*.7,d=2.98+delay*.4;
    if(t<a)return 0;if(t<b)return ease((t-a)/(b-a));if(t<c)return 1;
    if(t<d)return 1-1.018*ease((t-c)/(d-c));return -.018*(1-ease((t-d)/(CYCLE-d)));
  }
  function pose(kind,{state='working',time=0,motion=false,amplitude=0,phase}={}){
    if(!KINDS.includes(kind))throw new Error('Unknown field composition');
    amplitude=clamp(amplitude);time=Math.max(0,Number.isFinite(time)?time:0);
    const contraction=delay=>phase==='compact'?1:phase==='expanded'?0:state==='working'?(motion?gather(time,delay):.24):state==='offline'?.5:0;
    const outerGather=contraction(0),innerGather=contraction(.18),lightGather=contraction(.09);
    const breadth=state==='listening'?(motion?1+.065*amplitude:1.04):state==='speaking'?(motion?.97+.10*amplitude:1.02):1;
    const outerScale=(1-.17*outerGather)*breadth,innerScale=(1-.3*innerGather)*breadth;
    const outer=[],inner=[];
    for(let i=0;i<64;i++){
      const t=i*Math.PI*2/64;
      const r=(63+3.7*Math.sin(t+.4)+2.5*Math.sin(3*t+.8)+.9*Math.cos(5*t-.2))*outerScale;
      outer.push([f(128+Math.cos(t)*r),f(128+Math.sin(t)*r*.97)]);
      const ri=((kind==='open'?33:kind==='full'?22:27)+4*Math.sin(2*t+.6)+1.5*Math.sin(3*t-1))*innerScale;
      inner.push([f(131+Math.cos(t)*ri),f(126+Math.sin(t)*ri*1.04)]);
    }
    const lightScale=f(1-.13*lightGather);
    return {kind,state,center:{x:128,y:128},outer,inner,d:smooth(outer)+smooth(inner.slice().reverse()),
      lightScale,lightTransform:`translate(128 128) scale(${lightScale}) translate(-128 -128)`,
      opacity:state==='offline'?.38:1,outerScale:f(outerScale),innerScale:f(innerScale)};
  }
  function envelope(t){return clamp(Math.max(0,Math.sin(t*4.2))*(.6+.4*Math.sin(t*1.8+.5))*(.8+.2*Math.cos(t*13)));}
  function glow(cx,cy,r,color,peak,steps=64){
    let s='',previous=0;
    for(let i=steps;i>=1;i--){const t=i/steps,target=peak*Math.exp(-t*t/.27),a=(target-previous)/(1-previous);s+=`<circle cx="${cx}" cy="${cy}" r="${f(t*r)}" fill="${color}" opacity="${f(a)}"/>`;previous=target;}
    return s;
  }
  let serial=0;
  function svg(kind,{size=256,tile=false,theme='dark',mono=false,crisp=size<=32,state='idle',...options}={}){
    const P=pose(kind,{state,...options}),dark=theme==='dark',ink=dark?'#E6F4FF':'#14263E',id=`field-${++serial}`;
    let s=tile?`<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark?'#0A101E':'#EDF3FC'}" stroke="${dark?'#28334B':'#D2DDEC'}" stroke-width="1.1"/>`:'';
    if(!crisp&&!mono&&dark)s+=glow(128,128,100,'#437BFF',.16);
    if(!mono)s+=`<defs><clipPath id="${id}-clip"><path data-contour="true" d="${P.d}" clip-rule="evenodd" fill-rule="evenodd"/></clipPath></defs>`;
    s+=`<g data-field="true" opacity="${P.opacity}"><path data-contour="true" d="${P.d}" fill="${mono?ink:dark?'#437BFF':'#315EC0'}" fill-rule="evenodd"/>`;
    if(!mono){
      s+=`<g clip-path="url(#${id}-clip)"><g data-lights="true" transform="${P.lightTransform}">`;
      s+=glow(167,143,103,dark?'#72BEFF':'#4A91CC',.94);
      s+=glow(143,79,89,dark?'#A7DFFF':'#78B8DD',.98);
      s+=glow(152,77,47,dark?'#E5F5FF':'#A1D1E9',.7);
      s+=glow(85,143,70,dark?'#4275F0':'#315EB7',.35);
      s+='</g></g>';
    }
    s+='</g>';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}"><title id="${id}">${NAMES[kind]}</title>${s}</svg>`;
  }
  function micro({size=16,theme='dark',mono=false}={}){
    // Purpose-sized compound contour, 13px across with a clear, irregular opening.
    const P=pose('bloom',{state:'idle'}),ink=theme==='dark'?'#A7DFFF':'#2868B5';
    const fill=mono?(theme==='dark'?'#E6F4FF':'#14263E'):ink;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="Fluid field status mark"><path d="${P.d}" transform="translate(-4.8 -4.8) scale(.1)" fill="${fill}" fill-rule="evenodd"/></svg>`;
  }
  const api={KINDS,NAMES,CYCLE,pose,svg,micro,gather,envelope,clamp};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.OrganicField=api;
})(typeof globalThis==='undefined'?this:globalThis);
