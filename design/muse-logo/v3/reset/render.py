"""Fresh vector identity comparison, equivalent radial light rendering; no browser."""
from pathlib import Path
import sys
sys.dont_write_bytecode=True
import json
import subprocess
from PIL import Image,ImageDraw,ImageFont,ImageChops
from raster import raster,light
import xml.etree.ElementTree as ET

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'renders'
OUT.mkdir(exist_ok=True)
BG,PANEL,LINE,INK,MUTED,BLUE='#070C16','#0D1524','#26334A','#E6F0FF','#9DAEC8','#83C5FF'
KINDS=['relay','synthesis','parallel']
NAMES=['Relay','Synthesis','Parallel']

def font(size,bold=False):
    p=Path('/System/Library/Fonts/Supplemental')/('Arial Bold.ttf' if bold else 'Arial.ttf')
    if not p.exists():p=Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if bold else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
    return ImageFont.truetype(str(p),size)

def text(d,xy,value,size=20,fill=INK,bold=False):d.text(xy,value,font=font(size,bold),fill=fill)

def wrap(d,xy,value,width,size=20,fill=MUTED,leading=29):
    rows=[];current=''
    for word in value.split():
        trial=(current+' '+word).strip()
        if current and d.textlength(trial,font=font(size))>width:rows.append(current);current=word
        else:current=trial
    if current:rows.append(current)
    for i,row in enumerate(rows):text(d,(xy[0],xy[1]+i*leading),row,size,fill)

def paste(canvas,svg,xy,size):
    im=raster(svg,size);canvas.paste(im,xy,im)

def asset(kind,name):return (ROOT/'assets'/kind/(name+'.svg')).read_text()

code="""
const M=require('./marks.js'),out={};for(const k of M.KINDS)out[k]={
frames:Array.from({length:80},(_,i)=>M.svg(k,{state:'working',time:i*.04,motion:true,tile:true})),
beats:[0,.65,1.4,2.1,2.8,3.2].map(time=>M.svg(k,{state:'working',time,motion:true,tile:true}))
};process.stdout.write(JSON.stringify(out));
"""
DATA=json.loads(subprocess.check_output(['node','-e',code],cwd=ROOT,text=True))

hero=Image.new('RGB',(720,720),BG);paste(hero,asset('relay','app-icon-dark'),(40,40),640);hero.save(OUT/'relay-preview.png',optimize=True)

board=Image.new('RGB',(1800,1420),BG);d=ImageDraw.Draw(board)
text(d,(50,35),'IDENTITY RESET / THREE NEW FOUNDATIONS',16,BLUE,True)
text(d,(1380,35),'NAME INDEPENDENT / 31 OCT 2026',14,MUTED)
text(d,(47,87),'Blue light. Clear structure.',78)
text(d,(50,184),'Intent becomes action. Separate efforts become coherent. Work moves in parallel.',25,MUTED)
visions=['Intent becomes momentum.','Separate efforts. One result.','Independent work. Shared direction.']
descs=['Two solid fragments share a heading. The smaller execution piece draws into alignment with a stable intent.','Two independent light surfaces meet in a brighter common region. Coordination creates something shared.','Separate surfaces retain their identity while drawing into coordination around a stable foreground.']
tradeoffs=['Strongest tiny silhouette. Has a forward / play association.','Clearest shared-work metaphor. Has a layers association.','Quietest and most architectural. Has a signal / cards association.']
for i,kind in enumerate(KINDS):
    x=50+i*575
    d.rounded_rectangle((x,246,x+550,1075),18,fill=PANEL,outline=LINE)
    text(d,(x+24,270),f'0{i+1} / NEW DIRECTION',14,BLUE,True)
    paste(board,asset(kind,'app-icon-dark'),(x+95,325),360)
    text(d,(x+24,727),NAMES[i],38)
    text(d,(x+24,783),visions[i],23,INK)
    wrap(d,(x+24,828),descs[i],495,21,leading=30)
    wrap(d,(x+24,964),tradeoffs[i],495,18,MUTED,26)

text(d,(50,1111),'ACTUAL STATUS SIZES / 16, 20, 24, 32px',14,BLUE,True)
for i,kind in enumerate(KINDS):
    x=50+i*575
    for j,size in enumerate([16,20,24,32]):
        px=x+26+j*74;paste(board,asset(kind,f'status-{size}-dark'),(px,1200-size),size);text(d,(px,1220),str(size),12,MUTED)
    d.rounded_rectangle((x+365,1150,x+520,1305),12,fill='#EDF3FC');paste(board,asset(kind,'mono-light'),(x+375,1160),135)
    text(d,(x+383,1319),'One color',13,MUTED)
d.line((50,1360,1750,1360),fill=LINE)
text(d,(50,1381),'Fresh built-in ImageGen exploration informed these new editable SVGs. All final marks are vector paths and radial light surfaces.',15,MUTED)
board.save(OUT/'overview.png',optimize=True)

frames=[]
for index in range(80):
    im=Image.new('RGB',(1200,530),BG);di=ImageDraw.Draw(im)
    text(di,(28,22),'BLUE LIGHT / SILENT WORKING SIMULATIONS',16,BLUE,True)
    text(di,(970,22),f'{index*.04:.2f}s / 3.20s',15,MUTED)
    for i,kind in enumerate(KINDS):
        x=28+i*398;text(di,(x,70),f'0{i+1} / {NAMES[i]}',22)
        paste(im,DATA[kind]['frames'][index],(x+18,117),328)
        text(di,(x+18,465),['Handoff into alignment','Contributions draw together','Background draws closer'][i],14,MUTED)
    text(di,(28,505),'Actual component movement and alignment. No rotation, microphone, audio, API or live product state.',15,MUTED)
    frames.append(im)
atlas=Image.new('RGB',(1200,1590))
for j,index in enumerate([0,35,58]):atlas.paste(frames[index],(0,j*530))
palette=atlas.quantize(colors=256)
indexed=[im.quantize(palette=palette,dither=Image.Dither.FLOYDSTEINBERG) for im in frames]
indexed[0].save(OUT/'working-comparison.gif',save_all=True,append_images=indexed[1:],duration=40,loop=0,optimize=False,disposal=2)

contact=Image.new('RGB',(1560,955),BG);dc=ImageDraw.Draw(contact)
text(dc,(35,25),'ALIGNMENT / TIME SAMPLES',24)
for i,kind in enumerate(KINDS):
    y=90+i*280;text(dc,(35,y),NAMES[i],20,BLUE)
    for j,time in enumerate([0,.65,1.4,2.1,2.8,3.2]):
        x=35+j*250;paste(contact,DATA[kind]['beats'][j],(x,y+34),196);text(dc,(x+59,y+242),f'{time:.2f}s',14,MUTED)
contact.save(OUT/'motion-contact-sheet.png',optimize=True)

sizes=Image.new('RGB',(1650,970),BG);dz=ImageDraw.Draw(sizes)
text(dz,(40,30),'NEW SILHOUETTES / ACTUAL SIZE, MONO AND LIGHT',29)
text(dz,(40,82),'16 / 20 / 24 / 32px use dedicated micro drawings with crisp spacing. Large artwork keeps the light material.',19,MUTED)
for i,kind in enumerate(KINDS):
    x=40+i*540;text(dz,(x,139),NAMES[i],25,BLUE)
    for theme,y,bg in [('dark',190,PANEL),('light',330,'#EDF3FC')]:
        dz.rounded_rectangle((x,y,x+510,y+115),11,fill=bg)
        for j,size in enumerate([16,20,24,32]):
            px=x+40+j*115;paste(sizes,asset(kind,f'status-{size}-{theme}'),(px,y+60-size),size);text(dz,(px,y+82),f'{size}px',13,MUTED if theme=='dark' else '#52647C')
    for theme,y,bg in [('dark',470,PANEL),('light',528,'#EDF3FC')]:
        dz.rounded_rectangle((x,y,x+510,y+42),7,fill=bg);paste(sizes,asset(kind,f'status-16-{theme}'),(x+13,y+13),16);text(dz,(x+41,y+12),'Working / design simulation',14,INK if theme=='dark' else '#14263E')
    micro=raster(asset(kind,'status-16-dark'),16).resize((144,144),Image.Resampling.NEAREST);sizes.paste(micro,(x+8,620),micro);text(dz,(x+8,785),'16px / 9x proof',14,MUTED)
    paste(sizes,asset(kind,'mono-dark'),(x+173,616),150);text(dz,(x+181,785),'One color',14,MUTED)
    paste(sizes,asset(kind,'app-icon-light'),(x+349,608),155);text(dz,(x+354,785),'Light tile',14,MUTED)
text(dz,(40,882),'These are independent new concepts. Relay is the strongest small icon; Synthesis makes the shared-work idea most explicit.',18,INK)
text(dz,(40,925),'The monos simplify material depth. Exact state belongs to adjacent text. No name-dependent geometry or wordmark is drawn.',16,MUTED)
sizes.save(OUT/'sizes-and-use.png',optimize=True)

assets=list((ROOT/'assets').rglob('*.svg'))
for p in assets:assert raster(p.read_text(),128).getbbox(),p
# Check radial-gradient normalization: the generated radial light is clear at its square boundary.
sample_root=ET.fromstring(asset('relay','master'))
node=next(n for n in sample_root if n.get('data-glow'))
g=light(node,256);assert g.getpixel((20,130))[3]<2 and g.getpixel((128,130))[3]>20
gif=Image.open(OUT/'working-comparison.gif');assert gif.n_frames==80 and gif.info['loop']==0
durations=[]
for i in range(gif.n_frames):gif.seek(i);durations.append(gif.info['duration'])
assert durations==[40]*80
gif.seek(0);opened=gif.convert('RGB');gif.seek(35);gathered=gif.convert('RGB')
for x in [28,426,824]:assert ImageChops.difference(opened.crop((x,117,x+364,445)),gathered.crop((x,117,x+364,445))).getbbox()
proof=Image.new('RGB',(1200,1060),BG);proof.paste(opened,(0,0));proof.paste(gathered,(0,530));proof.save(OUT/'gif-decoded-proof.png',optimize=True)
report={'renderer':'PyMuPDF exact surface paths; Pillow equivalent declared SVG radial-gradient stops and clipping; no browser',
 'editable_svgs_rendered':len(assets),'gif_frames':gif.n_frames,'gif_duration_ms':sum(durations),'gif_size':[1200,530],
 'imagegen':'Built-in ImageGen used for an independent ideation contact sheet only. Final masters are newly drawn SVG geometry, not embedded generated bitmaps.',
 'clipping':'Masters use standard SVG gradients/clipPath. Non-browser renderer applies the same gradient stops, transforms and exact vector masks with Pillow.',
 'outputs':['relay-preview.png','overview.png','working-comparison.gif','motion-contact-sheet.png','sizes-and-use.png','gif-decoded-proof.png'],
 'scope':'Non-browser rendering and decoded GIF inspection. Browser layout, controls, gradient/clip playback and accessibility are unverified.'}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
