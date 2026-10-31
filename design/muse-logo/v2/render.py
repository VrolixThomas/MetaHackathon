"""Render SVGs without a browser: PyMuPDF rasterization + Pillow board composition.

Requires locally available fitz (PyMuPDF) and Pillow; installs nothing.
All output and temporary data stay within this v2 directory.
"""
from pathlib import Path
from io import BytesIO
import json
import subprocess
import xml.etree.ElementTree as ET
import fitz
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'renders'
OUT.mkdir(exist_ok=True)
DATA = json.loads((ROOT / 'render-samples.json').read_text())
INK, PAPER, MUTED, LINE = '#25332F', '#F5F3EC', '#5C6962', '#D7DACE'
BG = ['#FAE5DC', '#EEF0D5', '#E6E9F7']
KINDS = list(DATA)
NAMES = ['Pocket creature', 'Firefly', 'Octopus helper']
STATES = ['idle', 'listening', 'thinking', 'speaking', 'needs-input', 'success', 'error', 'offline']
LABELS = ['Idle', 'Listening', 'Thinking / working', 'Speaking', 'Needs input', 'Success', 'Error', 'Offline']
FONT = Path('/System/Library/Fonts/Supplemental')
def font(size, bold=False):
    file = FONT / ('Arial Bold.ttf' if bold else 'Arial.ttf')
    if not file.exists():
        file = Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    return ImageFont.truetype(str(file), size)

def raster(svg, size):
    ET.fromstring(svg)
    src = fitz.open(stream=svg.encode(), filetype='svg')
    doc = fitz.open('pdf', src.convert_to_pdf())
    page = doc[0]
    pix = page.get_pixmap(matrix=fitz.Matrix(size/page.rect.width, size/page.rect.height), alpha=True)
    result = Image.open(BytesIO(pix.tobytes('png'))).convert('RGBA')
    doc.close()
    src.close()
    return result

def paste(canvas, svg, xy, size):
    img = raster(svg, size)
    canvas.paste(img, xy, img)

def text(draw, xy, value, size=20, fill=INK, bold=False):
    draw.text(xy, value, font=font(size,bold), fill=fill)

def lines(draw, xy, value, width, size=20, fill=MUTED, leading=29):
    words, current, rows = value.split(), '', []
    for word in words:
        trial = (current+' '+word).strip()
        if draw.textlength(trial, font=font(size)) > width and current:
            rows.append(current)
            current = word
        else:
            current = trial
    if current:
        rows.append(current)
    for i, row in enumerate(rows):
        text(draw, (xy[0],xy[1]+i*leading), row,size,fill)
    return len(rows)*leading

# Main concept board, deliberately composed at 1x with true 16/20/24/32px samples.
board = Image.new('RGB',(1800,1470),PAPER)
d = ImageDraw.Draw(board)
text(d,(60,38),'IDENTITY STUDY V2',17,bold=True)
text(d,(1350,38),'THREE ORIGINAL COMPANIONS',15,fill=MUTED)
text(d,(56,87),'A little more alive.',76,bold=True)
text(d,(60,184),'Recognizable characters. Three different ways to pay attention and get to work.',25,fill=MUTED)

descriptions = [
    'A curious pocket creature that leans in to hear you and springs into action, making a voice engineering assistant feel approachable.',
    'A friendly firefly that opens its wings around a steady light, showing focused engineering work without losing its calm center.',
    'A soft eight-armed helper that gathers loose threads and opens them toward you, making parallel engineering work feel coordinated.'
]
personality = ['Curious, springy, slightly mischievous.','Precise, patient, quietly bright.','Capable, generous, a little busy.']
beat_labels = [['Gather','Squish','Peek & pop'],['Close','Open','Settle'],['Gather','Sort','Offer']]
for i,kind in enumerate(KINDS):
    x,y,w,h = 60+i*567,252,546,1030
    d.rounded_rectangle((x,y,x+w,y+h),22,fill='#FFFDF7',outline=LINE,width=1)
    text(d,(x+24,y+21),f'0{i+1} / COMPANION',15,bold=True)
    if i == 0:
        d.rounded_rectangle((x+w-172,y+16,x+w-20,y+45),14,fill=INK)
        text(d,(x+w-156,y+22),'RECOMMENDED',12,fill='#FFFDF7',bold=True)
    d.rounded_rectangle((x+20,y+66,x+w-20,y+364),16,fill=BG[i])
    paste(board,DATA[kind]['hero'],(x+108,y+61),306)
    d.rounded_rectangle((x+w-127,y+266,x+w-31,y+350),10,fill='#FFFDF7')
    paste(board,DATA[kind]['states']['idle'],(x+w-113,y+267),68)
    text(d,(x+w-111,y+333),'Static identity',11,fill=MUTED)
    text(d,(x+24,y+382),NAMES[i],34,bold=True)
    lines(d,(x+24,y+434),descriptions[i],w-48,21,leading=29)
    text(d,(x+24,y+567),personality[i],18,fill=INK)
    d.line((x+24,y+604,x+w-24,y+604),fill=LINE)
    text(d,(x+24,y+621),'WORKING / SAMPLED MOTION BEATS',12,fill=MUTED,bold=True)
    # Each drawing is a real sampled frame from the reusable mathematical model.
    for j,index in enumerate([0,1,2]):
        bx=x+31+j*167
        paste(board,DATA[kind]['beats'][index],(bx+15,y+644),110)
        text(d,(bx+12,y+760),beat_labels[i][j],14,fill=MUTED)
    text(d,(x+24,y+808),'ACTUAL PIXELS / MICRO AT 16–20',12,fill=MUTED,bold=True)
    for j,size in enumerate([16,20,24,32,64]):
        sx=x+51+j*95
        paste(board,DATA[kind]['micro'][str(size)],(sx-size//2,y+897-size),size)
        text(d,(sx-8,y+907),str(size),13,fill=MUTED)
    for j,(key,bg) in enumerate([('monoLight','#FFFDF7'),('monoDark','#202A29'),('tileDark','#E9EBE2')]):
        bx=x+24+j*168
        d.rounded_rectangle((bx,y+944,bx+158,y+1010),9,fill=bg,outline=LINE if j==0 else bg)
        paste(board,DATA[kind][key],(bx+7,y+947),58)
        text(d,(bx+72,y+968),['Mono','Mono','App tile'][j],13,fill='#F9F6ED' if j==1 else INK)
    # Tiny status usage: truthful simulation text stays next to a static micro mark.
    # This row sits below the card's drawings and is outside all animation bounds.

text(d,(60,1320),'01 / POCKET CREATURE',18,bold=True)
lines(d,(410,1314),'Recommended for the clearest tiny silhouette and the warmest personality. Firefly is strongest for a steady core; octopus most directly suggests parallel work.',1310,22,fill=INK,leading=31)
d.line((60,1406,1740,1406),fill=LINE)
text(d,(60,1429),'Design simulations only · Original editable SVGs · Name-neutral · No product, microphone or provider connection',17,fill=MUTED)
board.save(OUT/'overview.png',optimize=True)

# Full state sheet: color/light and mono/dark. No color-only state diagnosis.
sheet=Image.new('RGB',(1800,1140),PAPER)
ds=ImageDraw.Draw(sheet)
text(ds,(50,35),'STATIC STATES / REDUCED MOTION',26,bold=True)
text(ds,(50,79),'Exact state is carried by adjacent text. Expressions and held gestures support it.',19,fill=MUTED)
for i,kind in enumerate(KINDS):
    y=138+i*310
    text(ds,(50,y+8),f'0{i+1}  {NAMES[i]}',20,bold=True)
    for j,state in enumerate(STATES):
        x=306+j*180
        paste(sheet,DATA[kind]['states'][state],(x,y-9),112)
        text(ds,(x+1,y+111),LABELS[j],14,fill=MUTED)
        ds.rounded_rectangle((x-4,y+149,x+132,y+275),12,fill='#202A29')
        paste(sheet,DATA[kind]['darkStates'][state],(x+5,y+155),112)
    ds.line((50,y+294,1740,y+294),fill=LINE)
text(ds,(50,1095),'Success = current operation completed. Error/offline hold still; no shake, strobe or nagging loop.',17,fill=MUTED)
sheet.save(OUT/'static-states.png',optimize=True)

# Animated comparison rendered with non-browser tooling. Loop is illustrative only.
frames=[]
for n in range(60):
    canvas=Image.new('RGB',(1080,370),PAPER)
    dd=ImageDraw.Draw(canvas)
    text(dd,(24,17),'IDENTITY STUDY V2 / WORKING MOTION SIMULATION',14,bold=True)
    for i,kind in enumerate(KINDS):
        x=20+i*355
        dd.rounded_rectangle((x,55,x+335,330),16,fill=BG[i])
        paste(canvas,DATA[kind]['frames'][n],(x+59,61),218)
        text(dd,(x+22,291),f'0{i+1} / {NAMES[i]}',18,bold=True)
    text(dd,(24,347),'Sampled from the JS pose model; manual HTML preview includes all states and reduced motion.',13,fill=MUTED)
    frames.append(canvas)
palette=Image.new('RGB',(1,1))
# Shared palette prevents per-frame palette shimmer.
atlas=Image.new('RGB',(1080,370*3))
for j,index in enumerate([0,20,40]):atlas.paste(frames[index],(0,j*370))
palette=atlas.quantize(colors=128)
indexed=[f.quantize(palette=palette,dither=Image.Dither.NONE) for f in frames]
indexed[0].save(OUT/'working-comparison.gif',save_all=True,append_images=indexed[1:],duration=40,loop=0,optimize=False,disposal=2)

# Contact sheet includes more time points than the overview. Inspect this for clipping.
contact=Image.new('RGB',(1440,660),PAPER)
dc=ImageDraw.Draw(contact)
text(dc,(30,18),'WORKING MOTION / TIME SAMPLES (0.0, 0.4, 0.8, 1.2, 1.6, 2.0s)',18,bold=True)
for i,kind in enumerate(KINDS):
    for j,index in enumerate([0,10,20,30,40,50]):
        paste(contact,DATA[kind]['frames'][index],(j*240+32,i*200+48),180)
contact.save(OUT/'motion-contact-sheet.png',optimize=True)

# Separate true-size micro / tiny status contexts on both surfaces.
sizes=Image.new('RGB',(1500,700),PAPER)
dr=ImageDraw.Draw(sizes)
text(dr,(40,30),'SMALL-SIZE & PLACEMENT STUDY',27,bold=True)
text(dr,(40,78),'16/20px: dedicated simplified master. 24/32/64px: expressive master. Samples below are actual pixels.',19,fill=MUTED)
for i,kind in enumerate(KINDS):
    x=40+i*490
    text(dr,(x,143),NAMES[i],24,bold=True)
    for j,size in enumerate([16,20,24,32,64]):
        sx=x+35+j*91
        paste(sizes,DATA[kind]['micro'][str(size)],(sx-size//2,282-size),size)
        text(dr,(sx-9,300),str(size),15,fill=MUTED)
    for j,(key,bg) in enumerate([('monoNeedsLight','#FFFDF7'),('monoNeedsDark','#202A29')]):
        y=350+j*100
        dr.rounded_rectangle((x,y,x+450,y+80),12,fill=bg)
        paste(sizes,DATA[kind][key],(x+9,y+9),64)
        text(dr,(x+87,y+20),'Companion',19,fill='#F9F6ED' if j else INK,bold=True)
        text(dr,(x+87,y+47),'Needs input · simulated',15,fill='#CFD8CD' if j else MUTED)
    dr.rounded_rectangle((x,574,x+450,617),7,fill='#FFFDF7',outline=LINE)
    paste(sizes,DATA[kind]['micro']['16'],(x+12,587),16)
    text(dr,(x+38,587),'Companion',14,bold=True)
    text(dr,(x+245,588),'Working · simulated',13,fill=MUTED)
text(dr,(40,658),'Tiny rows keep a stable silhouette and an explicit label. Micro art is static; animated character detail starts at 24px.',17,fill=MUTED)
sizes.save(OUT/'sizes-and-use.png',optimize=True)

# Validate every delivered SVG by actual rasterization, including embedded CSS SVGs.
assets=sorted((ROOT/'assets').rglob('*.svg'))
for asset in assets:
    rendered=raster(asset.read_text(),120)
    if rendered.getbbox() is None:raise AssertionError(f'Empty asset {asset}')
probe_code = """const C=require('./companion.js');const a=[];for(const k of C.KINDS)for(const s of C.STATES)for(const t of [0,.3,.6,.9,1.2,1.5,2.1])for(const amp of [0,1])a.push({key:[k,s,t,amp].join('/'),svg:C.svg(k,{state:s,time:t,amplitude:amp,motion:true})});process.stdout.write(JSON.stringify(a));"""
probes=json.loads(subprocess.check_output(['node','-e',probe_code],cwd=ROOT,text=True))
for probe in probes:
    bounds=raster(probe['svg'],120).getbbox()
    if not bounds or bounds[0]<2 or bounds[1]<2 or bounds[2]>118 or bounds[3]>118:
        raise AssertionError(f"Motion exceeds reserved canvas: {probe['key']} {bounds}")
report={
    'renderer':'PyMuPDF SVG → PDF → raster, Pillow composition; no browser',
    'editable_svgs_rendered':len(assets),
    'animated_comparison_frames':len(frames),
    'static_matrix_poses':48,
    'motion_bounds_samples':len(probes),
    'motion_bounds_result':'All sampled rich poses retain at least 2px padding in the 120px canvas.',
    'outputs':['overview.png','static-states.png','sizes-and-use.png','motion-contact-sheet.png','working-comparison.gif'],
    'limits':['No browser navigation, local server, CLI browser, CDP or Electron launch.', 'CSS animation SVGs rasterized at their static fallback; motion samples use the shared JS pose model.', 'No browser layout, interaction, native accessibility or actual playback validation.', 'No microphone, provider, product or live-state connection.']
}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
