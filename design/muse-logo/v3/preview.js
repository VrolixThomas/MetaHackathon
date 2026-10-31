/* Preview-only controller. Uses Energy.pose(), the same model rendered into the GIF. */
(function () {
  'use strict';
  const E = Energy;
  const el = id => document.getElementById(id);
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hosts = Array.from(document.querySelectorAll('.hero')).map(host => ({
    kind: host.dataset.kind,
    particles: Array.from(host.querySelectorAll('[data-particle]')).map(group => ({ group, shape: group.firstElementChild })),
    // Halo geometry follows each particle; the core and its light remain fixed.
    halos: Array.from(host.querySelectorAll('[data-halo]'))
  }));
  let state = 'working', paused = false, phase, scrub = null, frame = null, time = 0, last = null, amplitude = .5;
  const reduced = () => preference.matches || el('reduce').checked;
  const a = (node, key, value) => node.setAttribute(key, String(value));
  function draw() {
    const moving = !reduced() && (!paused || scrub !== null) && !phase;
    for (const h of hosts) {
      const P = E.pose(h.kind, { state, time: scrub === null ? time : scrub, amplitude, motion: moving, phase });
      for (const { group, shape } of h.particles) {
        const p = P.particles[Number(group.dataset.particle)];
        a(group, 'opacity', p.opacity);
        if (p.length) {
          a(shape, 'x', -p.length / 2 - p.r); a(shape, 'y', -p.r);
          a(shape, 'width', p.length + p.r * 2); a(shape, 'height', p.r * 2); a(shape, 'rx', p.r);
          a(shape, 'transform', `translate(${p.x} ${p.y}) rotate(${p.angle})`);
        } else { a(shape, 'cx', p.x); a(shape, 'cy', p.y); a(shape, 'r', p.r); }
      }
      for (const halo of h.halos) {
        const p = P.particles[Number(halo.dataset.halo)];
        a(halo, 'transform', `translate(${p.x} ${p.y}) scale(${p.r * 3.7})`);
        a(halo, 'opacity', p.opacity);
      }
    }
    const t = scrub === null ? time % 3.2 : scrub;
    el('timeline').value = t.toFixed(2);
    el('time-value').textContent = t.toFixed(2) + 's';
    el('amplitude-value').textContent = amplitude.toFixed(2);
  }
  function updateLabels() {
    const mode = phase ? `${phase} pose` : reduced() ? 'reduced motion / fixed pose' : scrub !== null ? 'cycle inspection / fixed frame' : paused ? 'paused / fixed pose' : ['working','listening','speaking'].includes(state) ? 'motion simulation' : 'fixed state simulation';
    document.querySelectorAll('.live-label').forEach(n => { n.textContent = `${E.LABELS[state]} · ${mode}`; });
    el('simulation-heading').textContent = `${E.LABELS[state]} · ${mode}`;
    el('announcement').textContent = `Simulated state: ${E.LABELS[state]}. ${mode}.`;
    el('pause').textContent = paused ? 'Play' : 'Pause';
    a(el('pause'),'aria-pressed',paused);
    a(el('compact'),'aria-pressed',phase === 'compact');
    a(el('expanded'),'aria-pressed',phase === 'expanded');
  }
  function needsFrame() {
    if (document.hidden || reduced() || paused || phase || scrub !== null) return false;
    if (state === 'working') return true;
    if (state === 'success') return time < .85;
    return ['listening','speaking'].includes(state) && (el('synthetic').checked || Math.abs(amplitude - Number(el('amplitude').value)) > .001);
  }
  function tick(now) {
    frame = null;
    const dt = last === null ? 0 : Math.min(.05, (now - last) / 1000);
    last = now; time += dt;
    const target = el('synthetic').checked && ['listening','speaking'].includes(state) ? E.envelope(time) : Number(el('amplitude').value);
    amplitude += (target - amplitude) * (1 - Math.exp(-dt / (target > amplitude ? .065 : .22)));
    draw();
    if (needsFrame()) frame = requestAnimationFrame(tick); else last = null;
  }
  function wake() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; last = null; draw();
    if (needsFrame()) frame = requestAnimationFrame(tick);
  }
  function replay() { time = 0; phase = undefined; scrub = null; paused = false; updateLabels(); wake(); }
  el('state').addEventListener('change', () => { state = el('state').value; replay(); });
  el('replay').addEventListener('click', replay);
  el('pause').addEventListener('click', () => { paused = !paused; phase = undefined; scrub = null; updateLabels(); wake(); });
  el('reduce').addEventListener('change', () => { updateLabels(); wake(); });
  el('synthetic').addEventListener('change', wake);
  el('amplitude').addEventListener('input', () => {
    if (reduced() || paused) amplitude = Number(el('amplitude').value);
    wake();
  });
  for (const name of ['compact','expanded']) el(name).addEventListener('click', () => { phase = name; scrub = null; updateLabels(); wake(); });
  el('timeline').addEventListener('input', () => {
    scrub = Number(el('timeline').value); phase = undefined; paused = true; state = 'working'; el('state').value = state;
    updateLabels(); wake();
  });
  preference.addEventListener('change', () => { updateLabels(); wake(); });
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pagehide', () => { if (frame !== null) cancelAnimationFrame(frame); frame = null; });
  updateLabels(); wake();
})();
