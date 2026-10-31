"""Render the exact JS-authored SVG poses through PyMuPDF; compose with Pillow.

No browser, server, provider, installation or product call. Outputs stay inside v3.
"""
from pathlib import Path
from io import BytesIO
import json
import subprocess
import xml.etree.ElementTree as ET
import fitz
from PIL import Image, ImageDraw, ImageFont, ImageChops

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'renders'
OUT.mkdir(exist_ok=True)
BG, PANEL, INK, MUTED, LINE, AMBER = '#0B0D11', '#12151B', '#F7F1E8', '#A5A6AC', '#30343D', '#F6BC7A'
KINDS = ['gather', 'orbit', 'signal']
NAMES = ['Gather', 'Broken orbit', 'Signal field']
STATES = ['idle', 'listening', 'working', 'speaking', 'needs-input', 'success', 'error', 'offline']
LABELS = ['Idle', 'Listening', 'Working', 'Speaking', 'Needs input', 'Complete', 'Error', 'Offline']

def font(size, bold=False):
    p = Path('/System/Library/Fonts/Supplemental') / ('Arial Bold.ttf' if bold else 'Arial.ttf')
    if not p.exists():
        p = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    return ImageFont.truetype(str(p), size)

def text(d, xy, value, size=20, fill=INK, bold=False):
    d.text(xy, value, font=font(size, bold), fill=fill)

def wrap(d, xy, value, width, size=18, fill=MUTED, leading=28):
    rows, current = [], ''
    for word in value.split():
        trial = (current + ' ' + word).strip()
        if current and d.textlength(trial, font=font(size)) > width:
            rows.append(current)
            current = word
        else:
            current = trial
    if current:
        rows.append(current)
    for i, row in enumerate(rows):
        text(d, (xy[0], xy[1] + i * leading), row, size, fill)
    return len(rows) * leading

def raster(svg, size):
    ET.fromstring(svg)
    with fitz.open(stream=svg.encode(), filetype='svg') as source:
        with fitz.open('pdf', source.convert_to_pdf()) as doc:
            page = doc[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(size / page.rect.width, size / page.rect.height), alpha=True)
            return Image.open(BytesIO(pix.tobytes('png'))).convert('RGBA')

def paste(canvas, svg, xy, size):
    img = raster(svg, size)
    canvas.paste(img, xy, img)

def asset(kind, name):
    return (ROOT / 'assets' / kind / (name + '.svg')).read_text()

code = r"""
const E=require('./energy.js');const out={};
for(const kind of E.KINDS) out[kind]={
  frames:Array.from({length:80},(_,i)=>E.svg(kind,{state:'working',time:i*.04,motion:true,tile:true})),
  contact:[0,.64,1.28,1.5,2.2,2.88,3.2].map(time=>E.svg(kind,{state:'working',time,motion:true,tile:true})),
  poses:[0,.64,1.28,1.5,2.2,2.88,3.2].map(time=>E.pose(kind,{state:'working',time,motion:true})),
  speech:[0,.5,1].map(amplitude=>E.svg(kind,{state:'speaking',amplitude,motion:true,tile:true}))
};process.stdout.write(JSON.stringify(out));
"""
DATA = json.loads(subprocess.check_output(['node', '-e', code], cwd=ROOT, text=True))

# Overview: reference and the three proposals have equal-size icon presentations.
board = Image.new('RGB', (1920, 1510), BG)
d = ImageDraw.Draw(board)
text(d, (60, 38), 'IDENTITY STUDY V3 / ABSTRACT ENERGY', 16, AMBER, True)
text(d, (1490, 38), 'NAME INDEPENDENT / 31 OCT 2026', 14, MUTED)
text(d, (56, 85), 'One center. Coordinated energy.', 76)
text(d, (60, 181), 'Luminous white. Warm amber. Real gathering motion around a stable core.', 25, MUTED)

xs, width = [60, 525, 990, 1455], 405
source = Image.open(ROOT / 'reference/superiorswarm-user-reference.png').convert('RGBA')
for i, x in enumerate(xs):
    d.rounded_rectangle((x, 251, x + width, 809), 18, fill=PANEL, outline=LINE)
    text(d, (x + 22, 273), ['SOURCE / USER REFERENCE', '01 / RECOMMENDED', '02 / CLOSE ALTERNATIVE', '03 / CLOSE ALTERNATIVE'][i], 13, AMBER if i else MUTED, True)
    if i == 0:
        ref = source.resize((320, 325), Image.Resampling.LANCZOS)
        board.paste(ref, (x + 42, 318), ref)
        text(d, (x + 22, 669), 'SuperiorSwarm', 30)
        wrap(d, (x + 22, 719), 'Supplied 124 x 126px image, enlarged. Direct visual and motion reference.', 360, 18, leading=25)
    else:
        kind = KINDS[i - 1]
        paste(board, asset(kind, 'app-icon-dark'), (x + 42, 318), 320)
        text(d, (x + 22, 669), NAMES[i - 1], 30)
        desc = ['Uneven particles, layered depth. The strongest luminous, quiet identity.', 'Tangent fragments; an open field. More ordered and technical.', 'Radial fragments; asymmetric reach. More assertive and directional.'][i - 1]
        wrap(d, (x + 22, 719), desc, 360, 18, leading=25)

# Motion strip: expanded, gathered, and re-opened all use exact JS poses.
text(d, (60, 846), 'SAME CORE / THREE MOMENTS', 14, AMBER, True)
for i, kind in enumerate(KINDS):
    x = 60 + i * 620
    text(d, (x, 882), f'0{i + 1} / {NAMES[i]}', 21)
    for j, index in enumerate([0, 3, 6]):
        paste(board, DATA[kind]['contact'][index], (x + j * 195, 925), 168)
        text(d, (x + j * 195 + 3, 1104), ['Open / 0.00s', 'Gather / 1.50s', 'Settle / 3.20s'][j], 14, MUTED)

d.line((60, 1154, 1860, 1154), fill=LINE)
text(d, (60, 1182), 'REAL STATUS SIZES', 13, AMBER, True)
text(d, (60, 1214), '16 / 20 / 24 / 32px', 18)
text(d, (60, 1243), 'Purpose-drawn. No glow.', 15, MUTED)
for i, kind in enumerate(KINDS):
    x = 525 + i * 465
    for j, size in enumerate([16, 20, 24, 32]):
        px = x + j * 65
        paste(board, asset(kind, f'status-{size}-dark'), (px, 1235 - size), size)
        text(d, (px, 1254), str(size), 12, MUTED)
    d.rounded_rectangle((x + 289, 1180, x + 396, 1289), 8, fill='#F2EEE5')
    paste(board, asset(kind, 'mono-light'), (x + 306, 1188), 72)
    text(d, (x + 304, 1268), 'One color', 11, '#363434')

d.line((60, 1320, 1860, 1320), fill=LINE)
text(d, (60, 1350), 'RECOMMEND / 01 GATHER', 15, AMBER, True)
wrap(d, (525, 1344), 'Closest to the source: mature abstract light with uneven warm depth. Motion expresses coordinated attention; the fixed core preserves identity. No character, letter or name-dependent shape.', 1300, 23, INK, 32)
text(d, (60, 1460), 'Shared-pose SVG raster renders; no browser screenshots. Preview and GIF are silent design simulations, with no microphone or API.', 16, MUTED)
board.save(OUT / 'overview.png', optimize=True)

# 3.2s working comparison, exactly one shared-model cycle, 25fps.
frames = []
for index in range(80):
    img = Image.new('RGB', (1200, 500), BG)
    di = ImageDraw.Draw(img)
    text(di, (30, 21), 'WORKING / SILENT MOTION SIMULATION', 16, AMBER, True)
    text(di, (958, 21), f'{index * .04:0.2f}s / 3.20s', 16, MUTED)
    for i, kind in enumerate(KINDS):
        x = 30 + i * 398
        text(di, (x, 65), f'0{i + 1} / {NAMES[i]}', 21)
        paste(img, DATA[kind]['frames'][index], (x + 27, 108), 312)
        text(di, (x + 27, 435), ['Recommended / particle cluster', 'Tangent fragments', 'Radial fragments'][i], 14, MUTED)
    text(di, (30, 476), 'Stable core  |  outer 38% / mid 54% / inner 74%  |  staggered gather, release and settle  |  no spin', 14, MUTED)
    frames.append(img)
# One palette shared across all frames, including the brightest and most compact poses.
atlas = Image.new('RGB', (1200, 1500))
for j, index in enumerate([0, 37, 64]):
    atlas.paste(frames[index], (0, j * 500))
palette = atlas.quantize(colors=224)
indexed = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
indexed[0].save(OUT / 'working-comparison.gif', save_all=True, append_images=indexed[1:], duration=40, loop=0, optimize=False, disposal=2)

# Contact sheet: genuinely intermediate poses, useful for visible contraction QA.
sheet = Image.new('RGB', (1800, 910), BG)
ds = ImageDraw.Draw(sheet)
text(ds, (40, 28), 'WORKING / SHARED-POSE TIME SAMPLES', 23)
times = [0, .64, 1.28, 1.5, 2.2, 2.88, 3.2]
for i, kind in enumerate(KINDS):
    y = 91 + i * 265
    text(ds, (40, y), NAMES[i], 20, AMBER)
    for j, time in enumerate(times):
        x = 40 + j * 250
        paste(sheet, DATA[kind]['contact'][j], (x, y + 34), 196)
        text(ds, (x + 58, y + 236), f'{time:.2f}s', 14, MUTED)
sheet.save(OUT / 'motion-contact-sheet.png', optimize=True)

# Large, color and mono small-size contexts on both surfaces.
sizes = Image.new('RGB', (1620, 1030), BG)
dz = ImageDraw.Draw(sizes)
text(dz, (40, 30), 'SHARP SMALL / LUMINOUS LARGE', 28)
text(dz, (40, 82), 'Status marks below are actual 16 / 20 / 24 / 32px. The enlarged proof uses nearest-neighbor pixels.', 19, MUTED)
for i, kind in enumerate(KINDS):
    x = 40 + i * 530
    text(dz, (x, 138), f'0{i + 1} / {NAMES[i]}', 24, AMBER)
    for theme, y, bg in [('dark', 194, PANEL), ('light', 329, '#F2EEE5')]:
        dz.rounded_rectangle((x, y, x + 500, y + 112), 10, fill=bg)
        for j, size in enumerate([16, 20, 24, 32]):
            px = x + 40 + j * 110
            paste(sizes, asset(kind, f'status-{size}-{theme}'), (px, y + 57 - size), size)
            text(dz, (px, y + 77), str(size), 13, MUTED if theme == 'dark' else '#6D6860')
    for theme, y in [('dark', 469), ('light', 525)]:
        dz.rounded_rectangle((x, y, x + 500, y + 42), 7, fill=PANEL if theme == 'dark' else '#F2EEE5')
        paste(sizes, asset(kind, f'status-16-{theme}'), (x + 13, y + 13), 16)
        text(dz, (x + 40, y + 13), 'Working / design simulation', 14, INK if theme == 'dark' else '#292A2D')
    micro = raster(asset(kind, 'status-16-dark'), 16)
    sizes.paste(micro.resize((160, 160), Image.Resampling.NEAREST), (x + 10, 601), micro.resize((160, 160), Image.Resampling.NEAREST))
    text(dz, (x + 11, 778), '16px / 10x proof', 14, MUTED)
    paste(sizes, asset(kind, 'mono-dark'), (x + 186, 614), 144)
    text(dz, (x + 198, 778), 'One color', 14, MUTED)
    paste(sizes, asset(kind, 'app-icon-light'), (x + 350, 614), 144)
    text(dz, (x + 351, 778), 'Light icon', 14, MUTED)
    for j in range(3):
        paste(sizes, DATA[kind]['speech'][j], (x + j * 168, 833), 140)
text(dz, (40, 994), 'Bottom: simulated speaking envelope 0 / 0.5 / 1. Core geometry stays fixed; only field breadth changes.', 16, MUTED)
sizes.save(OUT / 'sizes-and-use.png', optimize=True)

states = Image.new('RGB', (1630, 670), BG)
de = ImageDraw.Draw(states)
text(de, (36, 26), 'REDUCED MOTION / FIXED STATE EQUIVALENTS', 24)
text(de, (36, 72), 'Text gives exact status. Supporting poses stay still; no color-only meanings, badges or moving speech envelope.', 16, MUTED)
for i, kind in enumerate(KINDS):
    y = 136 + i * 168
    text(de, (36, y + 50), NAMES[i], 17, AMBER)
    for j, state in enumerate(STATES):
        x = 220 + j * 174
        paste(states, asset(kind, f'reduced/{state}'), (x, y), 114)
        text(de, (x + 12, y + 125), LABELS[j], 14, MUTED)
states.save(OUT / 'reduced-states.png', optimize=True)

# Render all delivered masters and make an image-level movement check from the GIF.
assets = list((ROOT / 'assets').rglob('*.svg'))
for a in assets:
    img = raster(a.read_text(), 128)
    assert img.getbbox(), a
gif = Image.open(OUT / 'working-comparison.gif')
assert gif.n_frames == 80 and gif.info['loop'] == 0
durations = []
for i in range(gif.n_frames):
    gif.seek(i)
    durations.append(gif.info['duration'])
assert durations == [40] * 80
gif.seek(0)
frame0 = gif.convert('RGB')
gif.seek(37)
compact = gif.convert('RGB')
assert ImageChops.difference(frame0.crop((40, 100, 375, 425)), compact.crop((40, 100, 375, 425))).getbbox(), 'No visual contraction'
# Export representative decoded GIF frames for actual non-browser inspection.
proof = Image.new('RGB', (1200, 1000), BG)
proof.paste(frame0, (0, 0)); proof.paste(compact, (0, 500))
proof.save(OUT / 'gif-decoded-proof.png', optimize=True)
report = {
    'renderer': 'PyMuPDF SVG -> PDF -> PNG; Pillow board/GIF composition; no browser',
    'editable_svgs_rasterized': len(assets), 'gif_frames': gif.n_frames,
    'gif_duration_ms': sum(durations), 'gif_size': [1200, 500],
    'motion_difference': 'Decoded GIF open/gathered regions differ; deterministic geometry checks in validation.json.',
    'gradient_strategy': 'Editable concentric alpha circles preserve light in both SVG and PyMuPDF; no bitmap or SVG filter dependency.',
    'outputs': ['overview.png', 'working-comparison.gif', 'motion-contact-sheet.png', 'sizes-and-use.png', 'reduced-states.png', 'gif-decoded-proof.png'],
    'limits': ['No browser screenshot, layout, interaction, accessibility or actual browser playback verification.', 'GIF does not honor OS reduced motion; HTML respects it and has static controls.', 'No browser, server, CLI browser, CDP, Electron, microphone or provider used.']
}
(ROOT / 'render-validation.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps(report, indent=2))
