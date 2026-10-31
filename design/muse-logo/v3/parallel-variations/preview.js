(function(){
  'use strict';
  const P=ParallelVariations,el=id=>document.getElementById(id),pref=window.matchMedia('(prefers-reduced-motion: reduce)');
  let kind='compact',state='working',time=0,paused=false,phase,frame=null,last=null,candidate;
  const reference=el('reference').querySelectorAll('[data-layer]');
  const reduced=()=>pref.matches||el('reduce').checked,set=(n,k,v)=>n.setAttribute(k,String(v));
  function bind(){candidate=el('candidate').querySelectorAll('[data-layer]');}
  function draw(){
    const options={state,time,motion:!reduced()&&!phase,phase};
    for(const [k,nodes] of [['original',reference],[kind,candidate]]){
      const pose=P.pose(k,options);nodes.forEach(n=>{const q=pose.parts.find(p=>p.id===n.dataset.layer);set(n,'transform',q.transform);});
    }
  }
  function update(){
    const mode=phase?(phase==='compact'?'gathered pose':'resting pose'):reduced()?'reduced motion / fixed pose':paused?'paused / current pose':state==='working'?'working simulation / 3.2s':'at rest';
    el('reference-caption').textContent=mode;el('candidate-caption').textContent=P.NOTES[kind];el('candidate-title').textContent=`0${P.KINDS.indexOf(kind)+1} / ${P.NAMES[kind]}`;
    el('announcement').textContent=`Silent design comparison: Original and ${P.NAMES[kind]}. ${mode}.`;
    set(el('pause'),'aria-pressed',paused);el('pause').textContent=paused||phase?'Play':'Pause';for(const p of ['compact','expanded'])set(el(p),'aria-pressed',phase===p);
  }
  function needsFrame(){return !document.hidden&&!reduced()&&!paused&&!phase&&state==='working';}
  function tick(now){frame=null;const dt=last===null?0:Math.min(.05,(now-last)/1000);last=now;time+=dt;draw();if(needsFrame())frame=requestAnimationFrame(tick);else last=null;}
  function wake(){if(frame!==null)cancelAnimationFrame(frame);frame=null;last=null;draw();if(needsFrame())frame=requestAnimationFrame(tick);}
  function replay(){time=0;paused=false;phase=undefined;update();wake();}
  function choose(value){kind=value;el('kind').value=kind;el('candidate').innerHTML=P.svg(kind,{tile:true,size:310,state,idPrefix:'live'});bind();replay();}
  el('kind').addEventListener('change',()=>choose(el('kind').value));el('state').addEventListener('change',()=>{state=el('state').value;replay();});
  el('pause').addEventListener('click',()=>{if(phase){phase=undefined;paused=false;}else paused=!paused;update();wake();});el('replay').addEventListener('click',replay);
  for(const p of ['compact','expanded'])el(p).addEventListener('click',()=>{phase=p;update();wake();});el('reduce').addEventListener('change',()=>{update();wake();});
  document.querySelectorAll('.variation-pick').forEach(n=>n.addEventListener('click',()=>choose(n.dataset.kind)));
  pref.addEventListener('change',()=>{update();wake();});document.addEventListener('visibilitychange',wake);window.addEventListener('pagehide',()=>{if(frame!==null)cancelAnimationFrame(frame);frame=null;});bind();update();wake();
})();
