"""Non-browser SVG rasterization, using the exact shared blue-current pose model."""
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
BG, PANEL, LINE, INK, MUTED, BLUE = '#070C16', '#0D1524', '#26334A', '#E6F0FF', '#9DAEC8', '#83C5FF'
KINDS = ['confluence', 'interval', 'wake']
NAMES = ['Confluence', 'Open intervals', 'Long wake']

def font(size, bold=False):
    p = Path('/System/Library/Fonts/Supplemental') / ('Arial Bold.ttf' if bold else 'Arial.ttf')
    if not p.exists():
        p = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    return ImageFont.truetype(str(p), size)

def text(d, xy, value, size=20, fill=INK, bold=False):
    d.text(xy, value, font=font(size, bold), fill=fill)

def wrap(d, xy, value, width, size=20, fill=MUTED, leading=29):
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

data_code = """
const B=require('./current.js');const out={};for(const k of B.KINDS)out[k]={
 frames:Array.from({length:75},(_,i)=>B.svg(k,{state:'working',time:i*.04,motion:true,tile:true})),
 contact:[0,.5,1,1.34,2,2.7,3].map(time=>B.svg(k,{state:'working',time,motion:true,tile:true})),
 speech:[0,.5,1].map(amplitude=>B.svg(k,{state:'speaking',amplitude,motion:true,tile:true}))
};process.stdout.write(JSON.stringify(out));
"""
DATA = json.loads(subprocess.check_output(['node', '-e', data_code], cwd=ROOT, text=True))

# New composition leads; inspiration is explicitly separated and subordinate.
board = Image.new('RGB', (1920, 1520), BG)
d = ImageDraw.Draw(board)
text(d, (60, 38), 'BLUE REVISION / ORIGINAL LIGHT CURRENTS', 16, BLUE, True)
text(d, (1485, 38), 'NAME INDEPENDENT / 31 OCT 2026', 14, MUTED)
text(d, (57, 86), 'A different current.', 86)
text(d, (60, 193), 'An offset ice-blue focus. Three asymmetric streams. A directional silhouette of its own.', 25, MUTED)
positions = [(60, 800), (890, 470), (1390, 470)]
descriptions = [
    'Three curved channels converge toward a steady light seam. The long lower current, shorter upper trace and open right side form one recognizable wake.',
    'The same channels with extra intervals. More fragmented and energetic; less continuous at rest.',
    'Longer tail segments in the same geometry. More fluid and quiet; the curve takes precedence over the fragments.'
]
for i, (x, w) in enumerate(positions):
    d.rounded_rectangle((x, 267, x + w, 1008), 20, fill=PANEL, outline=LINE)
    text(d, (x + 26, 292), ['01 / RECOMMENDED', '02 / CLOSE VARIATION', '03 / CLOSE VARIATION'][i], 14, BLUE, True)
    size = 470 if i == 0 else 300
    y = 329 if i == 0 else 399
    paste(board, asset(KINDS[i], 'app-icon-dark'), (x + (w - size) // 2, y), size)
    text(d, (x + 28, 832), NAMES[i], 40 if i == 0 else 31)
    wrap(d, (x + 28, 892), descriptions[i], w - 56, 22 if i == 0 else 19, leading=30 if i == 0 else 28)

text(d, (60, 1049), 'REAL GATHERING / STABLE FOCUS', 15, BLUE, True)
for j, index in enumerate([0, 3, 6]):
    paste(board, DATA['confluence']['contact'][index], (60 + j * 201, 1100), 164)
    text(d, (62 + j * 201, 1276), ['Open / 0.00s', 'Gather / 1.34s', 'Settle / 3.00s'][j], 14, MUTED)

text(d, (735, 1049), 'TRUE STATUS SIZES', 15, BLUE, True)
for j, size in enumerate([16, 20, 24, 32]):
    x = 740 + j * 77
    paste(board, asset('confluence', f'status-{size}-dark'), (x, 1156 - size), size)
    text(d, (x - 1, 1184), f'{size}px', 12, MUTED)
d.rounded_rectangle((1075, 1094, 1225, 1244), 14, fill='#EDF3FC')
paste(board, asset('confluence', 'mono-light'), (1085, 1104), 130)
text(d, (1089, 1264), 'One-color proof', 13, MUTED)

reference = Image.open(ROOT.parent / 'reference' / 'superiorswarm-user-reference.png').convert('RGBA')
text(d, (1330, 1049), 'IDEATION REFERENCE / SUPERIORSWARM', 14, MUTED, True)
board.paste(reference, (1330, 1102), reference)
wrap(d, (1480, 1107), 'Atmosphere and living light informed the study. The proposed mark uses a directional wake, an offset seam and three continuous currents.', 350, 18, leading=27)

d.line((60, 1335, 1860, 1335), fill=LINE)
text(d, (60, 1367), 'PALETTE', 14, BLUE, True)
for i, color in enumerate(['#0A101E', '#437BFF', '#72BEFF', '#A7DFFF', '#E5F5FF']):
    x = 190 + i * 120
    d.rounded_rectangle((x, 1364, x + 85, 1402), 7, fill=color, outline=LINE)
    text(d, (x, 1415), color, 12, MUTED)
wrap(d, (910, 1362), 'Luminous depth and coordinated movement carry forward. The composition, silhouette, focus and blue palette are newly authored.', 900, 24, INK, 34)
text(d, (60, 1470), 'Editable vector masters / silent 3.0s working simulation / fixed reduced-motion poses / no browser, microphone or API used.', 16, MUTED)
board.save(OUT / 'overview.png', optimize=True)

# Exact shared model: three close variants, no browser or CSS approximation.
frames = []
for index in range(75):
    img = Image.new('RGB', (1200, 520), BG)
    di = ImageDraw.Draw(img)
    text(di, (28, 22), 'BLUE CURRENTS / SILENT WORKING SIMULATION', 16, BLUE, True)
    text(di, (970, 22), f'{index*.04:.2f}s / 3.00s', 15, MUTED)
    for i, kind in enumerate(KINDS):
        x = 28 + i * 398
        text(di, (x, 71), f'0{i+1} / {NAMES[i]}', 22)
        paste(img, DATA[kind]['frames'][index], (x + 18, 119), 328)
        text(di, (x + 18, 463), ['Recommended', 'More interruptions', 'Longer, quieter tails'][i], 14, MUTED)
    text(di, (28, 497), 'Outer current gathers first; middle and upper follow. The ice-blue seam stays fixed. No spin or audio.', 15, MUTED)
    frames.append(img)
atlas = Image.new('RGB', (1200, 1560))
for j, index in enumerate([0, 33, 56]):
    atlas.paste(frames[index], (0, j * 520))
palette = atlas.quantize(colors=256)
indexed = [img.quantize(palette=palette, dither=Image.Dither.NONE) for img in frames]
indexed[0].save(OUT / 'working-comparison.gif', save_all=True, append_images=indexed[1:], duration=40, loop=0, optimize=False, disposal=2)

contact = Image.new('RGB', (1800, 920), BG)
dc = ImageDraw.Draw(contact)
text(dc, (40, 25), 'ACTUAL GEOMETRY / OPEN, GATHER, RELEASE, SETTLE', 23)
for i, kind in enumerate(KINDS):
    y = 90 + i * 270
    text(dc, (40, y), NAMES[i], 20, BLUE)
    for j, time in enumerate([0, .5, 1, 1.34, 2, 2.7, 3]):
        x = 40 + j * 250
        paste(contact, DATA[kind]['contact'][j], (x, y + 35), 196)
        text(dc, (x + 64, y + 239), f'{time:.2f}s', 14, MUTED)
contact.save(OUT / 'motion-contact-sheet.png', optimize=True)

# One lead mark, with actual pixels and a nearest-neighbor enlargement for legibility.
sizeboard = Image.new('RGB', (1600, 990), BG)
dz = ImageDraw.Draw(sizeboard)
text(dz, (45, 30), 'CONFLUENCE / SHARP SMALL, LUMINOUS LARGE', 29)
text(dz, (45, 84), 'One core seam and three curved traces. The status variant uses open gaps and no glow.', 20, MUTED)
for theme, x, bg in [('dark', 45, PANEL), ('light', 830, '#EDF3FC')]:
    dz.rounded_rectangle((x, 148, x + 720, 314), 14, fill=bg)
    for j, size in enumerate([16, 20, 24, 32]):
        px = x + 55 + j * 160
        paste(sizeboard, asset('confluence', f'status-{size}-{theme}'), (px, 242-size), size)
        text(dz, (px, 267), f'{size}px', 16, MUTED if theme=='dark' else '#52647C')
    dz.rounded_rectangle((x, 339, x + 720, 397), 9, fill=bg)
    paste(sizeboard, asset('confluence', f'status-16-{theme}'), (x + 20, 360), 16)
    text(dz, (x + 50, 359), 'Working / design simulation', 17, INK if theme=='dark' else '#14263E')

micro = raster(asset('confluence','status-16-dark'),16)
micro = micro.resize((240,240),Image.Resampling.NEAREST)
sizeboard.paste(micro,(45,443),micro)
text(dz,(45,705),'16px / 15x pixel proof',16,MUTED)
paste(sizeboard,asset('confluence','mono-dark'),(385,448),230)
text(dz,(390,705),'One color / dark',16,MUTED)
dz.rounded_rectangle((775,443,1050,718),17,fill='#EDF3FC')
paste(sizeboard,asset('confluence','mono-light'),(793,460),240)
text(dz,(805,739),'One color / light',16,MUTED)
paste(sizeboard,asset('confluence','app-icon-light'),(1205,443),275)
text(dz,(1208,739),'Light app tile',16,MUTED)
text(dz,(45,810),'SIMULATED SPEAKING / 0, 0.5, 1',15,BLUE,True)
for j in range(3):
    paste(sizeboard,DATA['confluence']['speech'][j],(625+j*260,796),150)
wrap(dz,(45,851),'Field breadth follows a silent simulated envelope. The focal seam stays fixed. Reduced motion uses a fixed pose.',510,19,leading=29)
sizeboard.save(OUT/'sizes-and-use.png',optimize=True)

for svgfile in (ROOT/'assets').rglob('*.svg'):
    assert raster(svgfile.read_text(),128).getbbox(), svgfile
gif=Image.open(OUT/'working-comparison.gif')
assert gif.n_frames==75 and gif.info['loop']==0
durations=[]
for i in range(gif.n_frames):
    gif.seek(i);durations.append(gif.info['duration'])
assert durations==[40]*75
gif.seek(0);opened=gif.convert('RGB')
gif.seek(33);gathered=gif.convert('RGB')
assert ImageChops.difference(opened.crop((40,110,390,450)),gathered.crop((40,110,390,450))).getbbox()
proof=Image.new('RGB',(1200,1040),BG);proof.paste(opened,(0,0));proof.paste(gathered,(0,520));proof.save(OUT/'gif-decoded-proof.png',optimize=True)
report={
    'renderer':'Exact shared JS pose SVG -> PyMuPDF -> Pillow; no browser',
    'editable_svgs_rasterized':len(list((ROOT/'assets').rglob('*.svg'))),
    'gif_frames':gif.n_frames,'gif_duration_ms':sum(durations),'gif_size':[1200,520],
    'outputs':['overview.png','working-comparison.gif','motion-contact-sheet.png','sizes-and-use.png','gif-decoded-proof.png'],
    'scope':'Vector rasterizations, decoded GIF frames and deterministic poses. Browser layout, interaction, actual playback and accessibility remain unverified.'
}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
