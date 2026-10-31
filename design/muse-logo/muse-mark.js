/* Muse Openfold motion study. Original vectors, no runtime dependencies.
 * Expects an SVG with two [data-blade] paths, one [data-badge] group.
 * No network, audio, device or application access. */
(function (scope) {
  const NS = 'http://www.w3.org/2000/svg';
  const STATES = ['idle','listening','thinking','speaking','needs-input','success','error','offline'];
  const POSES = {
    idle: [0, 0, 1], listening: [4, -5, .95], thinking: [-2, 3, .91],
    speaking: [7, -9, .95], 'needs-input': [8, -10, .94],
    success: [0, 0, 1], error: [-2, 0, .94], offline: [-2, 0, .9],
  };
  const BADGES = {
    idle: '', listening: 'M44 51V47M50 56V42M56 51V47',
    thinking: 'M44 49H56M44 55H52', speaking: 'M43 53V47M50 58V42M57 53V47',
    'needs-input': 'M45 46C45 39 57 39 57 46C57 50 50 50 50 55M50 61V62',
    success: 'M42 51L48 57L60 43', error: 'M50 41V52M50 59V60',
    offline: 'M42 43L58 59M42 59L58 43',
  };
  function resolveMuseState(signals = {}) {
    // Foreground wins over background. Listening means capture actually active.
    if (signals.error) return 'error';
    if (signals.offline) return 'offline';
    if (signals.speaking) return 'speaking';
    if (signals.thinking) return 'thinking';
    if (signals.needsInput) return 'needs-input';
    if (signals.success) return 'success';
    if (signals.listening) return 'listening';
    return 'idle';
  }
  class MuseMark {
    constructor(svg, { state = 'idle', reducedMotion = false, decorative = false, direction = 'openfold', label } = {}) {
      this.svg = svg;
      this.blades = [...svg.querySelectorAll('[data-blade]')];
      this.badge = svg.querySelector('[data-badge]');
      this.badgePath = this.badge.querySelector('path');
      this.badge.style.transition = reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'none' : 'opacity 140ms ease';
      this.state = 'idle'; this.direction = direction; this.amplitude = 0;
      this.smoothedAmplitude = 0; this.reducedMotion = reducedMotion;
      this.media = matchMedia('(prefers-reduced-motion: reduce)');
      this.decorative = decorative; this.label = label;
      this.current = [0, 0, 1]; this.previous = 0; this.frame = 0; this.entered = performance.now();
      this.visible = !document.hidden;
      this.onVisibility = () => { this.visible = !document.hidden; this.wake(); };
      this.onMedia = () => this.wake();
      document.addEventListener('visibilitychange', this.onVisibility);
      this.media.addEventListener('change', this.onMedia);
      if (decorative) svg.setAttribute('aria-hidden', 'true');
      else svg.setAttribute('role', 'img');
      this.setState(state);
    }
    setState(state, label) {
      if (!STATES.includes(state)) throw new RangeError(`Unknown Muse state: ${state}`);
      if (state !== this.state) this.entered = performance.now();
      this.state = state;
      this.svg.dataset.state = state;
      this.badgePath.setAttribute('d', BADGES[state]);
      this.badge.style.opacity = state === 'idle' ? 0 : 1;
      if (!this.decorative) this.svg.setAttribute('aria-label', label || this.label || `Muse: ${state.replace('-', ' ')}`);
      this.wake();
    }
    setAmplitude(value) {
      this.amplitude = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      if (this.state === 'listening' || this.state === 'speaking') this.wake();
    }
    setReducedMotion(value) { this.reducedMotion = Boolean(value); this.wake(); }
    wake() { if (!this.frame) this.frame = requestAnimationFrame(t => this.tick(t)); }
    tick(now) {
      this.frame = 0;
      const dt = Math.min(64, this.previous ? now - this.previous : 16);
      this.previous = now;
      const reduced = this.reducedMotion || this.media.matches;
      const voice = this.state === 'listening' || this.state === 'speaking';
      this.badge.style.transition = reduced ? 'none' : 'opacity 140ms ease';
      const tau = this.amplitude > this.smoothedAmplitude ? 65 : 220;
      this.smoothedAmplitude += (this.amplitude - this.smoothedAmplitude) * (1 - Math.exp(-dt / tau));
      let [spread, angle, scale] = POSES[this.state];
      const t = now - this.entered;
      if (!reduced && this.visible) {
        if (['listening', 'thinking', 'speaking'].includes(this.state) && t < 90) {
          spread = -1.4; angle = 2; scale = .86;
        } else if (voice) {
          spread += this.smoothedAmplitude * (this.state === 'speaking' ? 5 : 4);
          angle -= this.smoothedAmplitude * 4;
          scale += this.smoothedAmplitude * .035;
        }
        if (this.state === 'thinking') {
          // One gentle fold per 3.6s; no rotation of the whole mark.
          const breath = (1 - Math.cos(t / 3600 * Math.PI * 2)) / 2;
          spread += breath * 5; angle -= breath * 5; scale += breath * .035;
        }
        if (this.state === 'success' && t < 520) scale += .045 * Math.sin(t / 520 * Math.PI);
      }
      const target = [spread, angle, scale];
      const ease = reduced ? 1 : 1 - Math.exp(-dt / 82);
      this.current = this.current.map((v, i) => v + (target[i] - v) * ease);
      const [s, a, z] = this.current;
      this.blades.forEach((blade, i) => {
        const sign = i ? 1 : -1;
        const x = this.direction === 'lumen' ? 0 : s * sign * .7;
        const y = s * sign;
        blade.setAttribute('transform', `translate(${x.toFixed(3)} ${y.toFixed(3)}) translate(50 50) rotate(${(a * sign).toFixed(3)}) scale(${z.toFixed(4)}) translate(-50 -50)`);
      });
      this.svg.style.opacity = this.state === 'offline' ? '.56' : '1';
      const unsettled = this.current.some((v, i) => Math.abs(v - target[i]) > .002);
      const amplitudeMoving = voice && Math.abs(this.amplitude - this.smoothedAmplitude) > .002;
      const looping = this.state === 'thinking' || (this.state === 'success' && t < 520) || (voice && t < 360);
      if (this.visible && (unsettled || (!reduced && (amplitudeMoving || looping)))) this.wake();
    }
    destroy() {
      cancelAnimationFrame(this.frame);
      document.removeEventListener('visibilitychange', this.onVisibility);
      this.media.removeEventListener('change', this.onMedia);
    }
    static markup(paths) {
      return `<svg xmlns="${NS}" viewBox="0 0 100 100" fill="currentColor" style="overflow:visible"><g>${paths.map(d => `<path data-blade d="${d}"/>`).join('')}</g><g data-badge style="opacity:0" transform="translate(29 29) scale(.58)" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="50" cy="50" r="21" fill="var(--surface, white)" stroke="none"/><path/></g></svg>`;
    }
  }
  scope.MuseMark = MuseMark;
  scope.resolveMuseState = resolveMuseState;
})(globalThis);
