(function(){
  'use strict';
  const F=OrganicField,el=id=>document.getElementById(id),pref=window.matchMedia('(prefers-reduced-motion: reduce)');
  const labels={working:'Working',idle:'At rest',listening:'Listening',speaking:'Speaking',offline:'Offline'};
  let kind='bloom',state='working',time=0,amplitude=.5,paused=false,phase,frame=null,last=null,contours,lights,field;
  const reduced=()=>pref.matches||el('reduce').checked;
  const set=(n,k,v)=>n.setAttribute(k,String(v));
  function bind(){contours=el('hero').querySelectorAll('[data-contour]');lights=el('hero').querySelector('[data-lights]');field=el('hero').querySelector('[data-field]');}
  function draw(){const p=F.pose(kind,{state,time,amplitude,motion:!reduced()&&!paused&&!phase,phase});contours.forEach(n=>set(n,'d',p.d));set(lights,'transform',p.lightTransform);set(field,'opacity',p.opacity);el('amp-value').textContent=amplitude.toFixed(2);}
  function update(){
    const mode=phase?(phase==='compact'?'gathered pose':'open pose'):reduced()?'reduced motion / fixed pose':paused?'paused / fixed pose':state==='working'?'gather, open and settle / 3.2s':['listening','speaking'].includes(state)?'simulated envelope':'fixed pose';
    el('caption').textContent=`${labels[state]} · ${mode}`;el('announcement').textContent=`Silent design simulation: ${labels[state]}. ${mode}.`;
    el('variant-title').textContent=`0${F.KINDS.indexOf(kind)+1} / ${F.NAMES[kind]}`;el('control-title').textContent=F.NAMES[kind];
    set(el('pause'),'aria-pressed',paused);el('pause').textContent=paused?'Play':'Pause';for(const p of ['compact','expanded'])set(el(p),'aria-pressed',phase===p);
  }
  function needsFrame(){return !document.hidden&&!reduced()&&!paused&&!phase&&(state==='working'||(['listening','speaking'].includes(state)&&(el('synthetic').checked||Math.abs(amplitude-Number(el('amplitude').value))>.001)));}
  function tick(now){frame=null;const dt=last===null?0:Math.min(.05,(now-last)/1000);last=now;time+=dt;const target=el('synthetic').checked&&['listening','speaking'].includes(state)?F.envelope(time):Number(el('amplitude').value);amplitude+=(target-amplitude)*(1-Math.exp(-dt/(target>amplitude?.065:.22)));draw();if(needsFrame())frame=requestAnimationFrame(tick);else last=null;}
  function wake(){if(frame!==null)cancelAnimationFrame(frame);frame=null;last=null;draw();if(needsFrame())frame=requestAnimationFrame(tick);}
  function replay(){time=0;paused=false;phase=undefined;update();wake();}
  el('state').addEventListener('change',()=>{state=el('state').value;replay();});el('kind').addEventListener('change',()=>{kind=el('kind').value;el('hero').innerHTML=F.svg(kind,{state,tile:true,size:420});bind();replay();});
  el('replay').addEventListener('click',replay);el('pause').addEventListener('click',()=>{paused=!paused;phase=undefined;update();wake();});
  for(const p of ['compact','expanded'])el(p).addEventListener('click',()=>{phase=p;update();wake();});
  el('reduce').addEventListener('change',()=>{update();wake();});el('synthetic').addEventListener('change',wake);el('amplitude').addEventListener('input',()=>{if(paused||reduced())amplitude=Number(el('amplitude').value);wake();});
  pref.addEventListener('change',()=>{update();wake();});document.addEventListener('visibilitychange',wake);window.addEventListener('pagehide',()=>{if(frame!==null)cancelAnimationFrame(frame);frame=null;});
  bind();update();wake();
})();
