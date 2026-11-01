(function(){
  'use strict';
  const el=id=>document.getElementById(id);let timer=null,controller;
  function clearTimer(){if(timer!==null)clearTimeout(timer);timer=null;}
  function update(state){
    el('status').textContent=state.transitioning?`Bringing illustrative item ${state.nextIndex+1} into focus…`:`Illustrative item ${state.focusIndex+1} held in focus · background work continues`;
    el('next').disabled=state.transitioning;el('pause').textContent=state.paused?'Resume motion':'Pause motion';el('pause').setAttribute('aria-pressed',String(state.paused));
    if(state.reducedMotion)el('auto').checked=false;
    clearTimer();if(el('auto').checked&&!state.reducedMotion&&!state.paused&&!state.transitioning&&!document.hidden)timer=setTimeout(()=>{timer=null;controller.advance();},PullForward.HOLD*1000);
  }
  controller=new PullForwardController(el('mark'),{size:330,backgroundMotion:true,decorative:true,onStateChange:update});
  el('next').addEventListener('click',()=>{el('auto').checked=false;clearTimer();controller.advance();});
  el('pause').addEventListener('click',()=>{if(controller.getState().paused)controller.resume();else controller.pause();});
  el('reset').addEventListener('click',()=>controller.reset());el('theme').addEventListener('change',()=>{el('stage').classList.toggle('light',el('theme').value==='light');controller.setTheme(el('theme').value);});
  el('background').addEventListener('change',()=>controller.setBackgroundMotion(el('background').checked));el('reduce').addEventListener('change',()=>controller.setReducedMotion(el('reduce').checked));el('auto').addEventListener('change',()=>update(controller.getState()));
  document.addEventListener('visibilitychange',()=>update(controller.getState()));window.addEventListener('pagehide',clearTimer);
})();
