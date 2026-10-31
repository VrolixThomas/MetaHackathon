/* Single visible live mark; the same cubic geometry produces the GIF. */
(function(){
  'use strict';
  const B=BlueCurrent,el=id=>document.getElementById(id),pref=window.matchMedia('(prefers-reduced-motion: reduce)');
  const LABEL={working:'Working',idle:'At rest',listening:'Listening',speaking:'Speaking',offline:'Offline'};
  let kind='confluence',state='working',time=0,amplitude=.5,paused=false,phase,raf=null,last=null;
  let paths,halos,traces;
  function bind(){paths=Array.from(el('hero').querySelectorAll('[data-current]'));halos=Array.from(el('hero').querySelectorAll('[data-halo]'));traces=Array.from(el('hero').querySelectorAll('[data-trace]'));}
  const set=(n,k,v)=>n.setAttribute(k,String(v));
  const reduced=()=>pref.matches||el('reduce').checked;
  function draw(){
    const P=B.pose(kind,{state,time,amplitude,motion:!reduced()&&!paused&&!phase,phase});
    const lookup=Object.fromEntries(P.currents.map(c=>[c.id,c]));
    for(const n of paths){const c=lookup[n.dataset.current];set(n,'d',B.pathD(c.points));set(n,'stroke-width',c.width);set(n,'opacity',c.opacity);}
    for(const h of halos){const c=lookup[h.dataset.halo],parts=h.querySelectorAll('path');set(h,'opacity',c.opacity);parts.forEach((n,i)=>{set(n,'d',B.pathD(c.points));set(n,'stroke-width',c.width+(36-i)/36*26);});}
    for(const n of traces){const p=P.traces.find(p=>p.id===n.dataset.trace);set(n,'d',B.lineD(p));set(n,'stroke-width',p.width);set(n,'opacity',p.opacity);}
    el('amplitude-value').textContent=amplitude.toFixed(2);
  }
  function labels(){
    const mode=phase?(phase==='compact'?'gathered pose':'open pose'):reduced()?'reduced motion / fixed pose':paused?'paused / fixed pose':state==='working'?'gathering and opening / 3.0s loop':['listening','speaking'].includes(state)?'simulated envelope':'fixed pose';
    const text=`${LABEL[state]} · ${mode}`;el('sim-label').textContent=text;el('announcement').textContent=`Silent design simulation: ${text}.`;
    el('variant-title').textContent=`0${B.KINDS.indexOf(kind)+1} / ${B.NAMES[kind]}`;
    el('control-title').textContent=B.NAMES[kind];
    el('choice-label').textContent=kind==='confluence'?'01 / Recommended direction':`0${B.KINDS.indexOf(kind)+1} / Close variation`;
    set(el('pause'),'aria-pressed',paused);el('pause').textContent=paused?'Play':'Pause';
    for(const p of ['compact','expanded'])set(el(p),'aria-pressed',phase===p);
  }
  function needsFrame(){return !document.hidden&&!reduced()&&!paused&&!phase&&(state==='working'||(['listening','speaking'].includes(state)&&(el('synthetic').checked||Math.abs(amplitude-Number(el('amplitude').value))>.001)));}
  function tick(now){raf=null;const dt=last===null?0:Math.min(.05,(now-last)/1000);last=now;time+=dt;
    const target=el('synthetic').checked&&['listening','speaking'].includes(state)?B.envelope(time):Number(el('amplitude').value);
    amplitude+=(target-amplitude)*(1-Math.exp(-dt/(target>amplitude?.065:.22)));draw();if(needsFrame())raf=requestAnimationFrame(tick);else last=null;
  }
  function wake(){if(raf!==null)cancelAnimationFrame(raf);raf=null;last=null;draw();if(needsFrame())raf=requestAnimationFrame(tick);}
  function replay(){time=0;phase=undefined;paused=false;labels();wake();}
  el('state').addEventListener('change',()=>{state=el('state').value;replay();});
  el('kind').addEventListener('change',()=>{kind=el('kind').value;el('hero').innerHTML=B.svg(kind,{tile:true,state,size:420});bind();replay();});
  el('replay').addEventListener('click',replay);
  el('pause').addEventListener('click',()=>{paused=!paused;phase=undefined;labels();wake();});
  for(const p of ['compact','expanded'])el(p).addEventListener('click',()=>{phase=p;labels();wake();});
  el('reduce').addEventListener('change',()=>{labels();wake();});
  el('synthetic').addEventListener('change',wake);
  el('amplitude').addEventListener('input',()=>{if(reduced()||paused)amplitude=Number(el('amplitude').value);wake();});
  pref.addEventListener('change',()=>{labels();wake();});
  document.addEventListener('visibilitychange',wake);
  window.addEventListener('pagehide',()=>{if(raf!==null)cancelAnimationFrame(raf);raf=null;});
  bind();labels();wake();
})();
