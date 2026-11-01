/* Dependency-free selected-mark controller. It never controls a work queue. */
(function(root,factory){
  if(typeof module!=='undefined'&&module.exports)module.exports=factory(require('./pull-forward.js'));
  else root.PullForwardController=factory(root.PullForward);
})(typeof globalThis==='undefined'?this:globalThis,function(Model){
  'use strict';
  const set=(n,k,v)=>n.setAttribute(k,String(v)),f=x=>Number(x.toFixed(4));
  const shade=(hex,amount)=>'#'+[1,3,5].map(i=>Math.round(parseInt(hex.slice(i,i+2),16)*amount).toString(16).padStart(2,'0')).join('');
  class Controller{
    constructor(host,options={}){
      if(!host||typeof host.querySelector!=='function')throw new TypeError('PullForwardController requires a host element');
      this.host=host;this.size=Number.isFinite(options.size)&&options.size>0?options.size:128;this.theme=options.theme==='light'?'light':'dark';
      this.background=options.backgroundMotion!==false;this.forceReduced=!!options.reducedMotion;this.decorative=options.decorative!==false;this.label=options.label||'One item in focus, background work continues';this.onStateChange=typeof options.onStateChange==='function'?options.onStateChange:null;
      this.focusIndex=0;this.time=0;this.transition=0;this.elapsed=0;this.transitioning=false;this.paused=false;this.disposed=false;this.frame=null;this.last=null;
      this.preference=window.matchMedia('(prefers-reduced-motion: reduce)');
      this.visibilityHandler=()=>this.wake();this.preferenceHandler=()=>this.reductionChanged();this.pageHideHandler=()=>this.cancelFrame();this.pageShowHandler=()=>this.wake();
      this.preference.addEventListener('change',this.preferenceHandler);document.addEventListener('visibilitychange',this.visibilityHandler);window.addEventListener('pagehide',this.pageHideHandler);window.addEventListener('pageshow',this.pageShowHandler);
      this.host.classList.add('pull-forward');this.host.style.setProperty('--pull-forward-size',this.size+'px');this.render();this.emit();
    }
    reduced(){return this.forceReduced||this.preference.matches;}
    getState(){return {focusIndex:this.focusIndex,nextIndex:(this.focusIndex+1)%3,transitioning:this.transitioning,progress:this.transition,paused:this.paused,reducedMotion:this.reduced(),backgroundMotion:this.background,theme:this.theme,destroyed:this.disposed};}
    emit(){if(!this.disposed&&this.onStateChange)this.onStateChange(this.getState());}
    options(){return {theme:this.theme,size:this.size,focusIndex:this.focusIndex,transition:this.transition,time:this.time,motion:!this.reduced(),background:this.background};}
    render(){
      if(this.disposed)return;this.host.innerHTML=Model.svg({...this.options(),idPrefix:'live'});this.svg=this.host.querySelector('svg');this.cache={};this.paintOrder='';
      if(this.decorative)this.svg.setAttribute('aria-hidden','true');else{this.svg.removeAttribute('aria-labelledby');this.svg.setAttribute('aria-label',this.label);}
      this.svg.setAttribute('focusable','false');
      this.svg.querySelectorAll('[data-layer]').forEach(layer=>{
        const id=layer.dataset.layer;this.cache[id]={layer,surface:layer.querySelector('[data-surface]'),edge:layer.querySelector('[data-edge]'),clip:this.svg.querySelector(`[data-clip-item="${id}"]`),lights:Array.from(layer.querySelectorAll('[data-item-light]')).map(g=>({g,channel:g.dataset.channel,circle:g.querySelector('circle'),stops:Array.from(g.querySelectorAll('[data-falloff]'))}))};
      });this.wake();
    }
    draw(){
      if(this.disposed)return;const pose=Model.pose(this.options()),light=this.theme==='light';
      for(const q of pose.parts){
        const c=this.cache[q.id];set(c.surface,'d',q.d);set(c.surface,'fill',light?shade(q.color,.84):q.color);set(c.clip,'d',q.d);set(c.edge,'d',q.edge);set(c.edge,'opacity',q.edgeOpacity);
        for(const l of c.lights){const second=l.channel==='secondary',x=q.cx+(second?9:0),y=q.cy-(second?6:0),r=q.r*(second?.52:1),peak=(second?q.secondaryPeak:q.primaryPeak)*(light?(second?.35:.55):1);set(l.circle,'cx',x);set(l.circle,'cy',y);set(l.circle,'r',r);set(l.g,'data-x',x);set(l.g,'data-y',y);set(l.g,'data-r',r);set(l.g,'data-peak',peak);l.stops.forEach(n=>set(n,'stop-opacity',f(Number(n.dataset.falloff)*peak)));}
      }
      const order=pose.parts.map(q=>q.id).join('/');if(order!==this.paintOrder){pose.parts.forEach(q=>this.svg.appendChild(this.cache[q.id].layer));this.paintOrder=order;}
    }
    needsFrame(){return !this.disposed&&!document.hidden&&!this.reduced()&&!this.paused&&(this.background||this.transitioning);}
    cancelFrame(){if(this.frame!==null)cancelAnimationFrame(this.frame);this.frame=null;this.last=null;}
    wake(){if(this.disposed)return;this.cancelFrame();this.draw();if(this.needsFrame())this.frame=requestAnimationFrame(now=>this.tick(now));}
    tick(now){
      this.frame=null;if(this.disposed)return;const dt=this.last===null?0:Math.min(.05,Math.max(0,(now-this.last)/1000));this.last=now;this.time+=dt;let completed=false;
      if(this.transitioning){this.elapsed+=dt;this.transition=Math.min(1,this.elapsed/Model.SWAP);if(this.transition>=1){this.focusIndex=(this.focusIndex+1)%3;this.transition=0;this.elapsed=0;this.transitioning=false;completed=true;}}
      this.draw();if(completed)this.emit();if(this.needsFrame()){if(this.frame===null)this.frame=requestAnimationFrame(t=>this.tick(t));}else this.last=null;
    }
    advance(){
      if(this.disposed||this.transitioning)return false;
      if(this.reduced()||this.paused){this.focusIndex=(this.focusIndex+1)%3;this.transition=0;this.elapsed=0;}else{this.transitioning=true;this.transition=0;this.elapsed=0;}
      this.wake();this.emit();return true;
    }
    reset(){if(this.disposed)return;this.focusIndex=0;this.time=0;this.transition=0;this.elapsed=0;this.transitioning=false;this.wake();this.emit();}
    pause(){if(this.disposed)return;this.paused=true;this.wake();this.emit();}
    resume(){if(this.disposed)return;this.paused=false;this.wake();this.emit();}
    setBackgroundMotion(enabled){if(this.disposed)return;this.background=!!enabled;this.wake();this.emit();}
    setTheme(theme){if(this.disposed)return;this.theme=theme==='light'?'light':'dark';this.render();this.emit();}
    setReducedMotion(enabled){if(this.disposed)return;this.forceReduced=!!enabled;this.reductionChanged();}
    reductionChanged(){if(this.disposed)return;if(this.reduced()&&this.transitioning){if(this.transition>.5)this.focusIndex=(this.focusIndex+1)%3;this.transition=0;this.elapsed=0;this.transitioning=false;}this.wake();this.emit();}
    destroy(){if(this.disposed)return;this.cancelFrame();this.disposed=true;this.preference.removeEventListener('change',this.preferenceHandler);document.removeEventListener('visibilitychange',this.visibilityHandler);window.removeEventListener('pagehide',this.pageHideHandler);window.removeEventListener('pageshow',this.pageShowHandler);this.onStateChange=null;}
  }
  return Controller;
});
