(function(){
  'use strict';
  const S=SharedFocus,el=id=>document.getElementById(id),pref=window.matchMedia('(prefers-reduced-motion: reduce)');
  const labels={working:'Working',idle:'At rest',listening:'Listening',speaking:'Speaking',offline:'Offline'};
  const host=el('hero'),contours=host.querySelectorAll('[data-contour]'),lights=host.querySelector('[data-lights]'),field=host.querySelector('[data-field]');
  const signals=host.querySelectorAll('[data-signal]'),halos=host.querySelectorAll('[data-signal-halo]'),threads=host.querySelectorAll('[data-thread]');
  let state='working',time=0,amplitude=.5,paused=false,phase,frame=null,last=null;
  const reduced=()=>pref.matches||el('reduce').checked,set=(n,k,v)=>n.setAttribute(k,String(v));
  function draw(){
    const p=S.pose({state,time,amplitude,motion:!reduced()&&!paused&&!phase,phase});
    contours.forEach(n=>set(n,'d',p.d));set(lights,'transform',p.lightTransform);set(field,'opacity',p.opacity);
    signals.forEach(n=>{const q=p.signals[Number(n.dataset.signal)];for(const k of ['cx','cy','r','opacity'])set(n,k,k==='cx'?q.x:k==='cy'?q.y:q[k]);});
    halos.forEach(n=>{const q=p.signals[Number(n.dataset.signalHalo)];set(n,'transform',`translate(${q.x} ${q.y}) scale(${q.r*3})`);set(n,'opacity',q.opacity);});
    threads.forEach(n=>{const q=p.signals[Number(n.dataset.thread)];set(n,'d',q.threadD);set(n,'opacity',q.threadOpacity);});
    el('amp-value').textContent=amplitude.toFixed(2);
  }
  function update(){
    const mode=phase?(phase==='compact'?'gathered pose':'open pose'):reduced()?'reduced motion / fixed pose':paused?'paused / fixed pose':state==='working'?'threads gather into context / 3.2s':['listening','speaking'].includes(state)?'simulated envelope':'fixed pose';
    el('caption').textContent=`${labels[state]} · ${mode}`;el('announcement').textContent=`Silent design simulation: ${labels[state]}. ${mode}.`;
    set(el('pause'),'aria-pressed',paused);el('pause').textContent=paused?'Play':'Pause';for(const p of ['compact','expanded'])set(el(p),'aria-pressed',phase===p);
  }
  function needsFrame(){return !document.hidden&&!reduced()&&!paused&&!phase&&(state==='working'||(['listening','speaking'].includes(state)&&(el('synthetic').checked||Math.abs(amplitude-Number(el('amplitude').value))>.001)));}
  function tick(now){frame=null;const dt=last===null?0:Math.min(.05,(now-last)/1000);last=now;time+=dt;const target=el('synthetic').checked&&['listening','speaking'].includes(state)?S.envelope(time):Number(el('amplitude').value);amplitude+=(target-amplitude)*(1-Math.exp(-dt/(target>amplitude?.065:.22)));draw();if(needsFrame())frame=requestAnimationFrame(tick);else last=null;}
  function wake(){if(frame!==null)cancelAnimationFrame(frame);frame=null;last=null;draw();if(needsFrame())frame=requestAnimationFrame(tick);}
  function replay(){time=0;paused=false;phase=undefined;update();wake();}
  el('state').addEventListener('change',()=>{state=el('state').value;replay();});el('replay').addEventListener('click',replay);el('pause').addEventListener('click',()=>{paused=!paused;phase=undefined;update();wake();});
  for(const p of ['compact','expanded'])el(p).addEventListener('click',()=>{phase=p;update();wake();});el('reduce').addEventListener('change',()=>{update();wake();});el('synthetic').addEventListener('change',wake);el('amplitude').addEventListener('input',()=>{if(paused||reduced())amplitude=Number(el('amplitude').value);wake();});
  pref.addEventListener('change',()=>{update();wake();});document.addEventListener('visibilitychange',wake);window.addEventListener('pagehide',()=>{if(frame!==null)cancelAnimationFrame(frame);frame=null;});
  update();wake();
})();
