(function(){
  'use strict';
  const F=FocusTheme,el=id=>document.getElementById(id),pref=window.matchMedia('(prefers-reduced-motion: reduce)');
  const set=(n,k,v)=>n.setAttribute(k,String(v)),f=x=>Number(x.toFixed(4));
  let kind='plane',palette='blue',focusIndex=0,time=0,paused=false,transitioning=false,transition=0,elapsed=0,frame=null,last=null,svg,cache,paintOrder='',lastLabel='';
  const reduced=()=>pref.matches||el('reduce').checked;
  function bind(){
    svg=el('hero').querySelector('svg');cache={};paintOrder='';
    svg.querySelectorAll('[data-layer]').forEach(layer=>{
      const id=layer.dataset.layer;
      cache[id]={layer,surface:layer.querySelector('[data-surface]'),edge:layer.querySelector('[data-edge]'),clip:svg.querySelector(`[data-clip-item="${id}"]`),lights:Array.from(layer.querySelectorAll('[data-item-light]')).map(g=>({g,channel:g.dataset.channel,circle:g.querySelector('circle'),stops:Array.from(g.querySelectorAll('[data-falloff]'))}))};
    });
  }
  function options(){return{palette,focusIndex,transition,time,motion:!reduced(),auto:el('auto').checked&&!reduced(),background:el('background').checked};}
  function focusLabel(p){
    const label=p.transition>0?`Bringing illustrative item ${p.nextIndex+1} into focus…`:`Illustrative item ${p.focusIndex+1} held for review · 2 continue behind`;
    if(label!==lastLabel){el('focus-caption').textContent=label;el('announcement').textContent=label+'. Silent design simulation.';lastLabel=label;}
  }
  function draw(){
    const p=F.pose(kind,options());
    for(const q of p.parts){const c=cache[q.id];set(c.surface,'d',q.d);set(c.surface,'fill',q.color);set(c.clip,'d',q.d);set(c.edge,'d',q.edge);set(c.edge,'opacity',q.edgeOpacity);
      for(const l of c.lights){const second=l.channel==='secondary',x=q.cx+(second?9:0),y=q.cy-(second?6:0),r=q.r*(second?.52:1),peak=second?q.secondaryPeak:q.primaryPeak;set(l.circle,'cx',x);set(l.circle,'cy',y);set(l.circle,'r',r);set(l.g,'data-x',x);set(l.g,'data-y',y);set(l.g,'data-r',r);set(l.g,'data-peak',peak);l.stops.forEach(n=>set(n,'stop-opacity',f(Number(n.dataset.falloff)*peak)));}
    }
    const order=p.parts.map(q=>q.id).join('/');if(order!==paintOrder){p.parts.forEach(q=>svg.appendChild(cache[q.id].layer));paintOrder=order;}
    focusLabel(p);
  }
  function labels(){el('layout-title').textContent=`0${F.KINDS.indexOf(kind)+1} / ${F.NAMES[kind]} · ${F.PALETTES[palette].name}`;set(el('pause'),'aria-pressed',paused);el('pause').textContent=paused?'Resume motion':'Pause motion';}
  function needsFrame(){return !document.hidden&&!reduced()&&!paused&&(transitioning||el('auto').checked||el('background').checked);}
  function tick(now){
    frame=null;const dt=last===null?0:Math.min(.05,(now-last)/1000);last=now;time+=dt;
    if(transitioning){elapsed+=dt;transition=Math.min(1,elapsed/F.SWAP);if(transition>=1){focusIndex=(focusIndex+1)%3;transition=0;elapsed=0;transitioning=false;}}
    draw();if(needsFrame())frame=requestAnimationFrame(tick);else last=null;
  }
  function wake(){if(frame!==null)cancelAnimationFrame(frame);frame=null;last=null;draw();if(needsFrame())frame=requestAnimationFrame(tick);}
  function stopTour(){if(el('auto').checked){const q=F.tour(time);focusIndex=(q.focusIndex+(q.transition>.5?1:0))%3;el('auto').checked=false;}}
  function reduceChanged(){if(reduced()){stopTour();if(transitioning&&transition>.5)focusIndex=(focusIndex+1)%3;transitioning=false;transition=0;elapsed=0;}labels();wake();}
  function render(){el('hero').innerHTML=F.svg(kind,{...options(),size:410,tile:true,idPrefix:'live'});bind();lastLabel='';labels();wake();}
  el('kind').addEventListener('change',()=>{kind=el('kind').value;render();});el('palette').addEventListener('change',()=>{palette=el('palette').value;render();});
  document.querySelectorAll('.layout-pick').forEach(n=>n.addEventListener('click',()=>{kind=n.dataset.kind;el('kind').value=kind;render();}));
  el('next').addEventListener('click',()=>{stopTour();if(transitioning)return;if(reduced()){focusIndex=(focusIndex+1)%3;transition=0;}else{transitioning=true;transition=0;elapsed=0;paused=false;}labels();wake();});
  el('pause').addEventListener('click',()=>{paused=!paused;labels();wake();});
  el('reset').addEventListener('click',()=>{time=0;focusIndex=0;transition=0;elapsed=0;transitioning=false;paused=false;labels();wake();});
  el('background').addEventListener('change',wake);
  el('auto').addEventListener('change',()=>{if(el('auto').checked){transitioning=false;transition=0;time=focusIndex*F.STEP;paused=false;}else{const q=F.tour(time);focusIndex=(q.focusIndex+(q.transition>.5?1:0))%3;transition=0;}if(reduced())reduceChanged();else{labels();wake();}});
  el('reduce').addEventListener('change',reduceChanged);pref.addEventListener('change',reduceChanged);document.addEventListener('visibilitychange',wake);window.addEventListener('pagehide',()=>{if(frame!==null)cancelAnimationFrame(frame);frame=null;});bind();labels();wake();
})();
