/* Original vector compositions and shared deterministic motion. No product bindings. */
(function (root) {
  'use strict';
  const KINDS = ['gather', 'orbit', 'signal'];
  const NAMES = { gather: 'Gather', orbit: 'Broken orbit', signal: 'Signal field' };
  const STATES = ['idle', 'listening', 'working', 'speaking', 'needs-input', 'success', 'error', 'offline'];
  const LABELS = { idle: 'Idle', listening: 'Listening', working: 'Working', speaking: 'Speaking', 'needs-input': 'Needs input', success: 'Complete', error: 'Error', offline: 'Offline' };
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, Number.isFinite(x) ? x : a));
  const f = x => Number(x.toFixed(4));
  // The reference's cubic-bezier(.4,0,.6,1), solved on x before evaluating y.
  function ease(x) {
    x = clamp(x);
    let lo = 0, hi = 1, u = x;
    for (let i = 0; i < 18; i++) {
      const v = 1.2 * u - .6 * u * u + .4 * u * u * u;
      if (v < x) lo = u; else hi = u;
      u = (lo + hi) / 2;
    }
    return u * u * (3 - 2 * u);
  }
  const PALETTE = ['#F8BD79', '#F19A50', '#D86D35', '#A54C2D'];
  // angle, distance, radius, depth group, palette index, base opacity.
  // Intentionally uneven: the open northwest margin balances a northeast / southwest flow.
  const SEEDS = [
    [-132, 33, 8.1, 'inner', 0, 1], [-26, 36, 6.4, 'inner', 1, 1],
    [81, 32, 5.7, 'inner', 0, .96], [166, 41, 4.6, 'inner', 2, .82],
    [-66, 61, 6.1, 'mid', 0, .97], [-18, 66, 5.2, 'mid', 1, .94],
    [32, 59, 4.4, 'mid', 2, .86], [104, 62, 5.2, 'mid', 1, .9],
    [145, 66, 4.2, 'mid', 2, .76], [-157, 64, 4.4, 'mid', 2, .72],
    [-103, 58, 3.2, 'mid', 1, .5],
    [-54, 91, 3.9, 'outer', 0, .8], [-30, 100, 2.6, 'outer', 1, .46],
    [2, 91, 3.1, 'outer', 2, .54], [48, 94, 2.8, 'outer', 1, .48],
    [77, 99, 2.2, 'outer', 0, .34], [118, 93, 3.4, 'outer', 2, .56],
    [145, 99, 2.5, 'outer', 3, .45], [177, 92, 2.8, 'outer', 2, .43],
    [-157, 94, 2.1, 'outer', 3, .38], [-104, 93, 1.9, 'outer', 2, .25],
    [-73, 106, 1.7, 'outer', 1, .28]
  ];
  function seeds(kind) {
    if (!KINDS.includes(kind)) throw new Error('Unknown composition');
    return SEEDS.map((s, i) => {
      let [a, d, r, group, color, opacity] = s;
      if (kind === 'orbit') {
        // Staggered arc fragments: elliptical field, no enclosing ring or global rotation.
        a += [0, 9, -7, 5, -3][i % 5];
        d *= group === 'outer' ? .97 : 1.04;
        r *= group === 'inner' ? .8 : .77;
      }
      if (kind === 'signal') {
        a += [5, -4, 9, -2][i % 4];
        d *= group === 'outer' ? .95 : 1;
        r *= group === 'inner' ? .78 : .72;
      }
      return { id: i, a, d, r, group, color, opacity };
    });
  }
  const TIMING = { outer: [.12, 1.24, 1.52, 2.91], mid: [.28, 1.39, 1.64, 3.02], inner: [.44, 1.5, 1.78, 3.1] };
  const MIN = { outer: .38, mid: .54, inner: .74 };
  function contraction(time, group) {
    const t = ((time % 3.2) + 3.2) % 3.2;
    const [start, gathered, release, open] = TIMING[group];
    if (t <= start) return 0;
    if (t < gathered) return ease((t - start) / (gathered - start));
    if (t < release) return 1;
    if (t < open) return 1 - 1.025 * ease((t - release) / (open - release));
    return -.025 * (1 - ease((t - open) / (3.2 - open)));
  }
  // A repeatable silent envelope for the preview only. Not audio or fake observed speech.
  function envelope(t) {
    const a = Math.max(0, Math.sin(t * 4.1));
    const b = .55 + .45 * Math.sin(t * 1.73 + .7);
    return clamp(a * b * (.72 + .28 * Math.sin(t * 13)));
  }
  function pose(kind, { state = 'idle', time = 0, amplitude = 0, motion = false, phase } = {}) {
    if (!STATES.includes(state)) throw new Error('Unknown state');
    amplitude = clamp(amplitude);
    time = Math.max(0, Number.isFinite(time) ? time : 0);
    const particles = seeds(kind).map(p => {
      let c = 0, breadth = 1, opacity = p.opacity;
      if (phase === 'compact') c = 1;
      else if (phase === 'expanded') c = 0;
      else if (state === 'working') c = motion ? contraction(time, p.group) : .26;
      else if (state === 'listening') breadth = motion ? 1.015 + .10 * amplitude : 1.08;
      else if (state === 'speaking') breadth = motion ? .92 + .20 * amplitude : 1.05;
      else if (state === 'needs-input') breadth = 1.08;
      else if (state === 'success') breadth = motion ? 1 + .1 * Math.sin(Math.PI * clamp(time / .8)) : 1.06;
      else if (state === 'error') c = .62;
      else if (state === 'offline') { c = .5; opacity *= .4; }
      const scale = (1 - (1 - MIN[p.group]) * c) * breadth;
      const shrink = 1 - (p.group === 'outer' ? .3 : p.group === 'mid' ? .16 : .07) * c;
      opacity *= 1 - (p.group === 'outer' ? .48 : p.group === 'mid' ? .24 : .05) * c;
      const angle = p.a * Math.PI / 180;
      let x = Math.cos(angle) * p.d * scale;
      let y = Math.sin(angle) * p.d * scale;
      if (kind === 'orbit') { x *= 1.04; y *= .86; }
      const radius = p.r * shrink;
      const length = kind === 'gather' ? 0 : kind === 'orbit' ? radius * (p.group === 'outer' ? 1.7 : 2.2) : radius * (p.group === 'outer' ? 1.6 : 2.6);
      return { id: p.id, group: p.group, x: f(128 + x), y: f(128 + y), r: f(radius), length: f(length), angle: f(p.a + (kind === 'orbit' ? 90 : 0)), color: PALETTE[p.color], opacity: f(clamp(opacity)), scale: f(scale) };
    });
    return { kind, state, core: { x: 128, y: 128, r: 13.5 }, particles };
  }
  let serial = 0;
  const shape = (p, color = p.color) => p.length
    ? `<rect x="${f(-p.length / 2 - p.r)}" y="${f(-p.r)}" width="${f(p.length + p.r * 2)}" height="${f(p.r * 2)}" rx="${p.r}" fill="${color}" transform="translate(${p.x} ${p.y}) rotate(${p.angle})"/>`
    : `<circle cx="${p.x}" cy="${p.y}" r="${p.r}" fill="${color}"/>`;
  // Vector-only gaussian-like falloff. Concentric alpha steps render consistently in
  // SVG viewers and PyMuPDF, which does not implement SVG gradient paint servers.
  function glow(x, y, radius, color, peak, extra = '') {
    let art = '', previous = 0;
    for (let i = 24; i >= 1; i--) {
      const r = i / 24;
      const target = peak * Math.exp(-r * r / .19);
      const alpha = (target - previous) / (1 - previous);
      art += `<circle r="${f(r)}" fill="${color}" opacity="${f(alpha)}"/>`;
      previous = target;
    }
    return `<g transform="translate(${x} ${y}) scale(${f(radius)})" ${extra}>${art}</g>`;
  }
  function svg(kind, options = {}) {
    const { size = 256, theme = 'dark', mono = false, tile = false, crisp = size <= 32, title = NAMES[kind], id = `e${++serial}` } = options;
    const P = options.pose || pose(kind, options);
    const ink = theme === 'dark' ? '#FFF3DF' : '#292A2D';
    const dark = theme === 'dark';
    let art = tile ? `<rect x="1" y="1" width="254" height="254" rx="57" fill="${dark ? '#0F1219' : '#F2EEE5'}" stroke="${dark ? '#383C43' : '#D4CFC4'}" stroke-width="1.2"/>` : '';
    if (!crisp && !mono && dark) art += glow(128, 128, 106, '#F5AC6A', .105);
    // Remote layer first, inner layer last. Halos are editable gradients, no bitmap/filter dependency.
    for (const group of ['outer', 'mid', 'inner']) for (const p of P.particles.filter(p => p.group === group)) {
      if (!crisp && !mono && dark && group !== 'outer') art += glow(p.x, p.y, p.r * 3.7, p.color, .28, `data-halo="${p.id}" opacity="${p.opacity}"`);
      const color = mono ? ink : dark ? p.color : (p.group === 'outer' ? '#90451F' : '#B85D22');
      art += `<g data-particle="${p.id}" data-depth="${p.group}" opacity="${mono ? 1 : p.opacity}">${shape(p, color)}</g>`;
    }
    if (!crisp && !mono && dark) art += glow(128, 128, 56, '#FFD5A4', .42) + glow(128, 128, 33, '#FFF4DC', .64);
    art += `<circle data-core="true" cx="128" cy="128" r="13.5" fill="${mono ? ink : dark ? '#FFFBF1' : '#25272B'}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256" role="img" aria-labelledby="${id}-title"><title id="${id}-title">${title}</title>${art}</svg>`;
  }
  // Purpose-drawn pixel-grid micro art: four satellites and a stable center, no glow.
  function micro(kind, { size = 16, theme = 'dark', mono = false } = {}) {
    const light = theme === 'light', color = mono ? (light ? '#292A2D' : '#FFF3DF') : (light ? '#A85218' : '#F5B36D');
    const center = mono ? color : light ? '#292A2D' : '#FFF8E9';
    let art = `<circle cx="8" cy="8" r="2" fill="${center}"/>`;
    const pts = [[5,4,1.25],[11.5,5.5,1],[10,12,1.25],[3.5,10.5,.85]];
    for (const [x,y,r] of pts) {
      if (kind === 'gather') art += `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`;
      else {
        const a = Math.atan2(y-8,x-8)*180/Math.PI+(kind==='orbit'?90:0);
        art += `<rect x="-1.5" y="-.75" width="3" height="1.5" rx=".75" fill="${color}" transform="translate(${x} ${y}) rotate(${f(a)})"/>`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 16 16" role="img" aria-label="${NAMES[kind]} status mark">${art}</svg>`;
  }
  const api = { KINDS, NAMES, STATES, LABELS, TIMING, MIN, ease, contraction, envelope, pose, svg, micro, clamp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Energy = api;
})(typeof globalThis === 'undefined' ? this : globalThis);
