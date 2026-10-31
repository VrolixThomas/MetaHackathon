/* Original vector companions. Portable, dependency-free design reference. */
(function (global) {
  'use strict';
  const STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking', 'needs-input', 'success', 'error', 'offline']);
  const KINDS = Object.freeze(['pocket', 'firefly', 'octopus']);
  const LABELS = Object.freeze({idle: 'Idle', listening: 'Listening', thinking: 'Thinking / working', speaking: 'Speaking', 'needs-input': 'Needs input', success: 'Success', error: 'Error', offline: 'Offline'});
  const COLORS = {pocket: '#E87759', firefly: '#D6DF77', octopus: '#8D9DE3'};
  const clamp = n => Number.isFinite(Number(n)) ? Math.max(0, Math.min(1, Number(n))) : 0;
  const f = n => Number(n.toFixed(3));
  const wave = (t, period) => Math.sin(t * Math.PI * 2 / period);
  const bump = (t, center, width) => Math.max(0, 1 - Math.abs(t - center) / width) ** 2;
  const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));

  // All movement lives inside the reserved 120-unit square. Time is state-local seconds.
  // A static pose is semantic: it does not depend on time or amplitude.
  function pose(kind, state = 'idle', time = 0, amplitude = 0, motion = true) {
    if (!KINDS.includes(kind) || !STATES.includes(state)) throw new RangeError('Unknown companion or state');
    const t = Math.max(0, Number.isFinite(time) ? time : 0), a = motion ? clamp(amplitude) : 0;
    const p = {x:0, y:0, tilt:0, sx:1, sy:1, gazeX:0, gazeY:0, blink:1, ear:0, wing:0, arms:0, gesture:0, mouth:0, glow:1, opacity:1, happy:0, worried:0};
    const active = ['listening','thinking','speaking'].includes(state);
    if (state === 'listening') {
      p.tilt = kind === 'pocket' ? -9 : kind === 'octopus' ? -6 : 0;
      p.gazeX = -2; p.gazeY = -1; p.ear = -14; p.wing = 12; p.arms = 10; p.sy = 1.035;
      if (motion) { p.ear -= a*12; p.wing += a*9; p.arms += a*8; p.gazeY -= a; }
    } else if (state === 'thinking') {
      p.gazeY = -3; p.sx = 1.05; p.sy = .95; p.ear = 12; p.wing = -10; p.arms = -17;
      if (motion) {
        const cycle = t % 2.4;
        if (kind === 'pocket') {
          const dip = bump(cycle, .38, .35), pop = bump(cycle, .86, .32);
          p.sx = 1 + dip*.14 - pop*.075; p.sy = 1 - dip*.17 + pop*.12;
          p.y = -pop*9; p.tilt = wave(t,4.8)*7; p.gazeX = wave(t,4.8)*3;
          p.ear = dip*30-pop*17; p.gesture = bump(cycle,1.62,.35)*20;
        } else if (kind === 'firefly') {
          p.sx = p.sy = 1; p.wing = 12 + wave(t,1.6)*27;
          p.glow = .74 + (wave(t,1.6)+1)*.13; p.gazeX = wave(t,3.2)*1.8;
          p.gesture = wave(t+.2,1.6)*9;
        } else {
          const gather = (1+Math.cos(t*Math.PI*2/2.4))*.5;
          p.arms = -28 + gather*64; p.gesture = wave(t+.35,2.4)*16;
          p.tilt = wave(t,2.4)*4; p.y = -gather*2; p.gazeX = wave(t,4.8)*2;
        }
      }
    } else if (state === 'speaking') {
      p.mouth = .65; p.ear = -8; p.wing = 25; p.arms = 19; p.gazeY = -1;
      if (motion) {
        p.mouth = .15+a*.85; p.sy = 1+a*.055; p.sx = 1-a*.035;
        p.ear -= a*10; p.wing += a*9; p.arms += a*9;
        p.gesture = a*12;
      }
    } else if (state === 'needs-input') {
      p.tilt = kind === 'firefly' ? 0 : 12; p.gazeX = 3; p.gazeY = -2;
      p.ear = -24; p.wing = 32; p.arms = 27; p.gesture = 26; p.mouth = .1;
      // One small invitation, then hold. No nagging pulse.
      if (motion && t < .65) p.gesture += Math.sin(t/.65*Math.PI)*10;
    } else if (state === 'success') {
      p.happy = 1; p.ear = -13; p.wing = 37; p.arms = 32; p.gesture = 9;
      if (motion && t < .72) {
        const hop = Math.sin(t/.72*Math.PI);
        if (kind !== 'firefly') { p.y = -hop*10; p.sx = 1-hop*.06; p.sy = 1+hop*.07; }
        p.wing += hop*7; p.arms += hop*7;
      }
    } else if (state === 'error') {
      p.worried=1; p.sx=.96; p.sy=.96; p.gazeY=2; p.ear=26; p.wing=-22; p.arms=-25; p.gesture=-7;
    } else if (state === 'offline') {
      p.blink=.14; p.sy=.94; p.gazeY=2; p.ear=32; p.wing=-29; p.arms=-29; p.glow=.45;
    }
    if (motion && (active || state === 'idle')) {
      const bt = (t + (kind === 'firefly' ? .45 : kind === 'octopus' ? 1.1 : 0)) % 5.4;
      p.blink = 1 - bump(bt,4.7,.13)*.92;
      if (state === 'idle') { p.gazeX = 1.7*wave(t,8); p.ear = 3*wave(t,6); }
    }
    if (kind === 'firefly') { p.x=0; p.y=0; p.sx=1; p.sy=1; p.tilt=0; }
    if (!active && state !== 'idle' && state !== 'needs-input' && state !== 'success') p.gesture = Math.min(p.gesture,0);
    return p;
  }

  function attributes(kind, p) {
    const pivot = (cx,cy,angle,sx=1,sy=1) => `translate(${cx} ${cy}) rotate(${f(angle)}) scale(${f(sx)} ${f(sy)}) translate(${-cx} ${-cy})`;
    const smile = p.happy ? 'M55 70Q61 77 67 69' : p.worried ? 'M55 73Q61 67 67 73' : 'M56 72Q61 75 66 71';
    return {
      rig:{transform:`translate(${f(p.x)} ${f(p.y)}) ${pivot(60,91,p.tilt,p.sx,p.sy)}`,opacity:f(p.opacity)},
      earLeft:{transform:pivot(39,48,p.ear)}, earRight:{transform:pivot(82,48,-p.ear*.72)},
      footLeft:{transform:pivot(43,85,-p.gesture)}, footRight:{transform:pivot(76,85,p.gesture)},
      wingLeft:{transform:pivot(54,53,-p.wing)}, wingRight:{transform:pivot(66,53,p.wing)},
      feelerLeft:{transform:pivot(53,39,-p.gesture*.4)}, feelerRight:{transform:pivot(67,39,p.gesture*.4)},
      glow:{opacity:f(p.glow)},
      arm0:{transform:pivot(41,70,p.arms)},arm1:{transform:pivot(46,78,p.arms*.75)},
      arm2:{transform:pivot(53,82,p.arms*.35)},arm3:{transform:pivot(59,83,p.arms*.2)},
      arm4:{transform:pivot(65,83,-p.arms*.2)},arm5:{transform:pivot(72,81,-p.arms*.4)},
      arm6:{transform:pivot(78,77,-p.arms*.8)},arm7:{transform:pivot(83,69,-p.arms-p.gesture*.65)},
      eyes:{transform:`translate(0 61) scale(1 ${f(p.blink)}) translate(0 -61)`},
      pupils:{transform:`translate(${f(p.gazeX)} ${f(p.gazeY)})`},
      mouthLine:{d:smile,opacity:p.mouth>.2?0:1},
      mouthOpen:{ry:f(1.7+p.mouth*4),opacity:p.mouth>.2?1:0},
      happyEyes:{opacity:p.happy},normalEyes:{opacity:1-p.happy},
      brow:{opacity:p.worried}
    };
  }

  function scene(kind, p, options={}) {
    const dynamic = attributes(kind,p), mono=!!options.mono, theme=options.theme||'light';
    const ink = theme==='dark' ? '#F9F6ED' : '#25332F';
    const surface = theme==='dark' ? '#202A29' : '#FFFDF7';
    const c = mono ? ink : COLORS[kind], dark = mono ? ink : '#25332F', eye=mono?surface:'#FFF9EB';
    const core = !mono && theme==='dark' ? '#9AAD96' : dark;
    const accent=mono?ink:kind==='pocket'?'#F5A58A':kind==='octopus'?'#BEC8F2':'#EAF0AE';
    function el(name,tag,attrs,children='') {
      const a={...attrs,...(dynamic[name]||{})};
      return `<${tag}${name?` data-part="${name}"`:''} ${Object.entries(a).map(([k,v])=>`${k}="${escape(v)}"`).join(' ')}>${children}</${tag}>`;
    }
    const path=(name,d,fill,extra={})=>el(name,'path',{d,fill,...extra});
    const group=(name,children,attrs={})=>el(name,'g',attrs,children);
    const line=(name,d,color,width=3)=>path(name,d,'none',{stroke:color,'stroke-width':width,'stroke-linecap':'round','stroke-linejoin':'round'});
    const ell=(name,cx,cy,rx,ry,fill)=>el(name,'ellipse',{cx,cy,rx,ry,fill});
    let body='';
    if (kind==='pocket') {
      body += path('earLeft','M35 51C26 43 23 25 30 23C39 21 45 39 46 47Z',c);
      body += path('earRight','M75 47C78 32 90 28 96 35C103 43 90 53 82 55Z',c);
      body += path('footLeft','M35 80C28 88 32 97 44 96C53 96 57 86 52 82Z',c);
      body += path('footRight','M68 82C63 88 68 97 80 95C90 93 91 85 84 80Z',c);
      body += path('', 'M24 62C24 44 39 36 60 37C81 34 96 48 96 67C99 83 84 93 66 92L49 93C31 94 21 83 24 62Z',c);
      if(!mono) body += path('', 'M33 53C37 45 46 42 54 43','none',{stroke:accent,'stroke-width':5,'stroke-linecap':'round'});
    } else if (kind==='firefly') {
      body += group('wingLeft',path('','M54 49C46 26 21 26 20 43C18 59 36 73 55 72C60 64 59 55 54 49Z',c)+(!mono?line('','M49 52Q38 44 29 42',accent,2.5):''));
      body += group('wingRight',path('','M66 49C74 26 99 26 100 43C102 59 84 73 65 72C60 64 61 55 66 49Z',c)+(!mono?line('','M71 52Q82 44 91 42',accent,2.5):''));
      body += line('', 'M51 63L43 71M50 71L42 81M69 63L77 71M70 71L78 81',core,3);
      body += group('feelerLeft',line('','M54 39Q50 28 44 26',core,3)+ell('',43,25,3,3,core));
      body += group('feelerRight',line('','M66 39Q70 28 76 26',core,3)+ell('',77,25,3,3,core));
      body += path('', 'M46 62C44 44 49 36 60 36C71 36 76 44 74 62L73 79C72 91 67 98 60 98C53 98 48 91 47 79Z',core);
      body += group('glow',path('','M48 76Q60 81 72 76L71 84C68 97 52 97 49 84Z',mono?eye:'#EFF2A2'));
      if(!mono) body += line('','M53 87Q60 91 67 87','#C2CF68',2.4);
    } else {
      const arms=[
        'M44 63C33 62 25 52 19 56C12 62 28 79 42 78Z',
        'M48 73C34 76 29 83 24 80C18 76 15 81 19 87C28 99 45 88 52 83Z',
        'M53 78C43 85 45 94 39 94C33 94 33 100 40 101C51 102 57 90 59 82Z',
        'M57 79C52 91 56 101 62 101C68 100 64 95 64 91L64 80Z',
        'M63 79C64 92 70 101 77 98C82 95 74 94 73 89L70 78Z',
        'M70 77C77 88 85 94 92 89C98 84 93 79 89 83C86 86 81 78 79 74Z',
        'M78 68C88 72 98 79 103 72C109 64 101 61 98 66C95 69 89 62 82 62Z',
        'M80 61C90 58 94 49 100 51C108 55 97 69 84 73Z'
      ];
      arms.forEach((d,i)=>body+=path(`arm${i}`,d,c));
      body+=path('','M34 66C33 43 40 27 57 26C78 22 87 40 87 63C91 78 79 85 60 84C42 84 31 78 34 66Z',c);
      if(!mono) body+=path('','M43 43C46 35 51 32 57 33','none',{stroke:accent,'stroke-width':5,'stroke-linecap':'round'});
    }
    const cx = kind==='firefly' ? [54,66] : kind==='octopus' ? [50,71] : [48,73];
    const cy=kind==='firefly'?51:kind==='octopus'?59:61;
    const rx=kind==='firefly'?4.1:5.4, ry=kind==='firefly'?6:8;
    let eyes = group('normalEyes',cx.map(x=>ell('',x,cy,rx,ry,eye)).join('')+group('pupils',cx.map(x=>ell('',x+.6,cy+1,2.15,3.55,dark)).join('')));
    eyes+=group('happyEyes',cx.map(x=>line('',`M${x-4} ${cy+2}Q${x} ${cy-4} ${x+4} ${cy+2}`,eye,2.8)).join(''));
    body+=group('eyes',eyes);
    body+=group('brow',line('',`M${cx[0]-4} ${cy-8}l7 -3M${cx[1]-3} ${cy-11}l7 3`,dark,2.3));
    if(kind!=='firefly') body+=line('mouthLine','M56 72Q61 75 66 71',mono?eye:dark,2.5)+ell('mouthOpen',61,72,3.3,3,mono?eye:dark);
    return group('rig',body);
  }

  function svg(kind, {state='idle', time=0, amplitude=0, motion=false, theme='light', mono=false, size=120, decorative=false, id='companion', small=false}={}) {
    if (small) return smallSVG(kind,{theme,mono,size});
    const label=`Companion: ${kind}, ${LABELS[state]}`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}" class="companion" data-kind="${kind}" data-state="${state}" ${decorative?'aria-hidden="true"':`role="img" aria-label="${escape(label)}"`} style="overflow:visible">${scene(kind,pose(kind,state,time,amplitude,motion),{theme,mono})}</svg>`;
  }

  // Purpose-drawn micro masters: fewer details and larger eye gaps, no moving parts.
  function smallSVG(kind,{theme='light',mono=false,size=16}={}) {
    const fg=mono?(theme==='dark'?'#F9F6ED':'#25332F'):COLORS[kind], bg=theme==='dark'?'#202A29':'#FFFDF7';
    const dark=mono?fg:kind==='firefly'&&theme==='dark'?'#9AAD96':'#25332F';
    let s='';
    if(kind==='pocket') s=`<path d="M4 6C2 2 4 0 6 4C8 3 10 3 11 4C14 1 16 4 13 6C16 12 13 15 10 14H5C1 15 0 9 4 6Z" fill="${fg}"/><path d="M5 7v2M10 7v2" stroke="${mono?bg:dark}" stroke-width="1.5" stroke-linecap="round"/>`;
    if(kind==='firefly') s=`<path d="M7 5C3 0 0 2 1 6C2 8 4 10 7 10M9 5C13 0 16 2 15 6C14 8 12 10 9 10" fill="${fg}"/><path d="M6 2L5 1M10 2l1-1" stroke="${dark}" stroke-linecap="round"/><rect x="5.5" y="2" width="5" height="13" rx="2.5" fill="${dark}"/><path d="M6.5 11h3" stroke="${mono?bg:'#EFF2A2'}" stroke-width="2"/><path d="M7 5h.01M9 5h.01" stroke="${bg}" stroke-width="1.4" stroke-linecap="round"/>`;
    if(kind==='octopus') s=`<path d="M4 8V6C4 0 12 0 12 6V8C14 8 14 5 16 6C16 10 13 11 12 11C16 14 13 16 11 12C12 16 8 16 8 12C7 16 3 15 5 12C0 15 0 11 3 11C0 10 0 7 2 7Z" fill="${fg}"/><path d="M6 6v1M10 6v1" stroke="${mono?bg:dark}" stroke-width="1.5" stroke-linecap="round"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" role="img" aria-label="Companion: ${kind}, simplified small-size silhouette">${s}</svg>`;
  }

  class Controller {
    constructor(root,{kind=root.dataset.kind,state='thinking',amplitude=0,reducedMotion=false,mono=false,theme='light',decorative=false}={}) {
      if(!KINDS.includes(kind))throw new RangeError('Unknown companion');
      this.root=root; this.kind=kind; this.state='idle'; this.amplitude=clamp(amplitude); this.level=0;
      this.manualReduce=!!reducedMotion; this.paused=false; this.dead=false; this.elapsed=0; this.frame=0;
      this.mq=global.matchMedia('(prefers-reduced-motion: reduce)');
      root.innerHTML=scene(kind,pose(kind,'idle'),{mono,theme});
      this.parts=new Map([...root.querySelectorAll('[data-part]')].map(e=>[e.dataset.part,e]));
      if(decorative) {root.setAttribute('aria-hidden','true');root.removeAttribute('role');root.removeAttribute('aria-label');}
      this.decorative=decorative;
      this.onReduce=()=>{this.cancel();this.draw();this.start();};
      this.onVisibility=()=>{this.cancel();if(!root.ownerDocument.hidden)this.start();};
      this.mq.addEventListener('change',this.onReduce);
      root.ownerDocument.addEventListener('visibilitychange',this.onVisibility);
      this.tick=this.tick.bind(this);this.setState(state);
    }
    get reduced(){return this.manualReduce||this.mq.matches;}
    setState(state){
      if(!STATES.includes(state))throw new RangeError('Unknown state');
      this.state=state;this.elapsed=0;this.current=null;this.root.dataset.state=state;
      if(!this.decorative){this.root.setAttribute('role','img');this.root.setAttribute('aria-label',`Companion: ${this.kind}, ${LABELS[state]}`);}
      this.cancel();this.draw();this.start();
    }
    setAmplitude(value){this.amplitude=clamp(value);this.start();}
    setReducedMotion(value){this.manualReduce=!!value;this.onReduce();}
    setPaused(value){this.paused=!!value;this.cancel();this.draw();this.start();}
    cancel(){if(this.frame)global.cancelAnimationFrame(this.frame);this.frame=0;this.last=null;}
    start(){if(!this.dead&&!this.frame&&!this.reduced&&!this.paused&&!this.root.ownerDocument.hidden)this.frame=global.requestAnimationFrame(this.tick);}
    draw(){
      const moving=!this.reduced&&!this.paused;
      const next=pose(this.kind,this.state,this.elapsed,this.level,moving);
      if(!moving||!this.current)this.current=next;
      const attrs=attributes(this.kind,this.current);
      for(const [name,values]of Object.entries(attrs)){
        const node=this.parts.get(name);if(node)for(const [key,value]of Object.entries(values))node.setAttribute(key,value);
      }
    }
    tick(now){
      this.frame=0;if(this.dead)return;
      const dt=this.last===null?0:Math.min((now-this.last)/1000,.05);this.last=now;this.elapsed+=dt;
      const tau=this.amplitude>this.level?.065:.22;
      this.level+=(this.amplitude-this.level)*(1-Math.exp(-dt/tau));
      const next=pose(this.kind,this.state,this.elapsed,this.level,true);
      if(!this.current)this.current=next;
      for(const key of Object.keys(next))this.current[key]+=(next[key]-this.current[key])*(1-Math.exp(-dt/.045));
      this.draw();
      // Error/offline are held. Invitation and celebration are one-shot gestures.
      const held=['error','offline'].includes(this.state)||(['success','needs-input'].includes(this.state)&&this.elapsed>1.3);
      if(!held)this.start();else this.last=null;
    }
    destroy(){this.dead=true;this.cancel();this.mq.removeEventListener('change',this.onReduce);this.root.ownerDocument.removeEventListener('visibilitychange',this.onVisibility);}
  }
  const API={STATES,KINDS,LABELS,COLORS,clamp,pose,attributes,scene,svg,smallSVG,Controller};
  if(typeof module!=='undefined'&&module.exports)module.exports=API;
  global.Companion=API;
})(typeof window!=='undefined'?window:globalThis);
