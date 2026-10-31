/* Offline study controls. Deliberately no media or product integration. */
(() => {
  const $=id=>document.getElementById(id), mq=matchMedia('(prefers-reduced-motion: reduce)');
  const cards=[...document.querySelectorAll('.direction')];
  let controllers=[],tourTimer=0,sampleFrame=0,paused=false;
  const staticMode=()=>mq.matches||$('reduce').checked;
  function create(){
    controllers.forEach(c=>c.destroy());
    controllers=cards.map((card,i)=>{
      const svg=card.querySelector('.live-companion svg');
      const c=new Companion.Controller(svg,{kind:Companion.KINDS[i],state:$('state').value,amplitude:$('amplitude').value,reducedMotion:$('reduce').checked,theme:$('dark').checked?'dark':'light',decorative:true});
      c.setPaused(paused);return c;
    });
    updateLabels();
  }
  function updateLabels(){
    const label=Companion.LABELS[$('state').value];
    cards.forEach(card=>{card.querySelector('.live-state').textContent=label;card.querySelector('.tiny-state').textContent=`${label} · simulated`;});
    $('announcement').textContent=`Simulated state: ${label}${staticMode()?' · static pose':paused?' · paused':''}`;
  }
  function setState(value){$('state').value=value;controllers.forEach(c=>c.setState(value));updateLabels();}
  function stopTour(){clearInterval(tourTimer);tourTimer=0;$('tour').setAttribute('aria-pressed','false');$('tour').textContent='Play state tour';}
  function cancelSample(){if(sampleFrame)cancelAnimationFrame(sampleFrame);sampleFrame=0;}
  function sample(now){
    sampleFrame=0;
    if(!$('sample').checked||staticMode()||paused||document.hidden)return;
    // Explicit synthetic envelope. This is never a measurement or captured audio.
    const a=Math.max(0,Math.sin(now/260)*.31+Math.sin(now/97)*.17+.45);
    controllers.forEach(c=>c.setAmplitude(a));$('amp-value').textContent=a.toFixed(2);
    sampleFrame=requestAnimationFrame(sample);
  }
  function resumeSample(){cancelSample();if($('sample').checked&&!staticMode()&&!paused&&!document.hidden)sampleFrame=requestAnimationFrame(sample);else{controllers.forEach(c=>c.setAmplitude($('amplitude').value));$('amp-value').textContent=Number($('amplitude').value).toFixed(2);}}
  $('state').addEventListener('change',()=>{stopTour();setState($('state').value);});
  $('amplitude').addEventListener('input',()=>{$('sample').checked=false;resumeSample();});
  $('sample').addEventListener('change',resumeSample);
  $('replay').addEventListener('click',()=>setState($('state').value));
  $('pause').addEventListener('click',()=>{paused=!paused;controllers.forEach(c=>c.setPaused(paused));$('pause').setAttribute('aria-pressed',String(paused));$('pause').textContent=paused?'Resume motion':'Pause motion';if(paused)stopTour();$('tour').disabled=staticMode()||paused;resumeSample();updateLabels();});
  $('tour').addEventListener('click',()=>{
    if(tourTimer){stopTour();return;}
    if(staticMode()||paused)return;
    let i=0;setState(Companion.STATES[i]);
    $('tour').setAttribute('aria-pressed','true');$('tour').textContent='Stop state tour';
    tourTimer=setInterval(()=>{i++;if(i>=Companion.STATES.length){stopTour();return;}setState(Companion.STATES[i]);},2600);
  });
  function updateReduction(){
    controllers.forEach(c=>c.setReducedMotion($('reduce').checked));
    if(staticMode())stopTour();
    $('sample').disabled=staticMode();$('tour').disabled=staticMode()||paused;
    resumeSample();updateLabels();
  }
  $('reduce').addEventListener('change',updateReduction);mq.addEventListener('change',updateReduction);
  $('dark').addEventListener('change',()=>{document.body.classList.toggle('dark-stage',$('dark').checked);create();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){stopTour();cancelSample();}else resumeSample();});
  window.addEventListener('pagehide',()=>{stopTour();cancelSample();controllers.forEach(c=>c.destroy());});
  create();updateReduction();
})();
