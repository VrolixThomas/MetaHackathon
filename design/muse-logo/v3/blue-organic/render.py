"""Render only this study, without browser/server/media/provider access."""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
import json
import subprocess
from PIL import Image, ImageDraw, ImageFont, ImageChops
from raster import raster

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'renders'
OUT.mkdir(exist_ok=True)
BG,PANEL,LINE,INK,MUTED,BLUE='#070C16','#0D1524','#26334A','#E6F0FF','#9DAEC8','#83C5FF'
KINDS=['bloom','open','full']
NAMES=['Fluid field','Open field','Full field']

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
const F=require('./field.js'),out={};for(const k of F.KINDS)out[k]={
frames:Array.from({length:80},(_,i)=>F.svg(k,{state:'working',motion:true,time:i*.04,tile:true})),
beats:[0,.6,1.1,1.4,2.1,2.8,3.2].map(time=>F.svg(k,{state:'working',motion:true,time,tile:true})),
speech:[0,.5,1].map(amplitude=>F.svg(k,{state:'speaking',motion:true,amplitude,tile:true}))
};process.stdout.write(JSON.stringify(out));
"""
DATA=json.loads(subprocess.check_output(['node','-e',code],cwd=ROOT,text=True))

# Easy-to-open single image, with no board text or competing directions.
hero=Image.new('RGB',(720,720),BG)
paste(hero,asset('bloom','app-icon-dark'),(40,40),640)
hero.save(OUT/'icon-preview.png',optimize=True)

board=Image.new('RGB',(1800,1390),BG);d=ImageDraw.Draw(board)
text(d,(50,35),'IDENTITY REFINEMENT / ORGANIC BLUE',16,BLUE,True)
text(d,(1380,35),'NAME INDEPENDENT / 31 OCT 2026',14,MUTED)
text(d,(47,88),'Rounder. Softer. Alive.',78)
text(d,(50,184),'One fluid circular body, an uneven opening and the blue palette you liked.',25,MUTED)
for i,kind in enumerate(KINDS):
    x=50+i*575
    d.rounded_rectangle((x,246,x+550,918),18,fill=PANEL,outline=LINE)
    text(d,(x+24,270),['01 / RECOMMENDED','02 / MORE OPEN','03 / MORE BODY'][i],14,BLUE,True)
    paste(board,asset(kind,'app-icon-dark'),(x+95,326),360)
    text(d,(x+24,730),NAMES[i],36)
    wrap(d,(x+24,792),['A gently uneven contour and off-center opening. Distributed blue light gives the circular field a soft, organic quality.','A larger opening lightens the same silhouette and lets more space into the center.','A smaller opening makes the same field denser and more tactile.'][i],495,22,leading=31)
text(d,(50,960),'GEOMETRY GATHERS / OPENING FOLLOWS',14,BLUE,True)
for j,index in enumerate([0,3,6]):
    paste(board,DATA['bloom']['beats'][index],(50+j*190,1005),158)
    text(d,(53+j*190,1175),['Open / 0.00s','Gather / 1.40s','Settle / 3.20s'][j],13,MUTED)
text(d,(720,960),'ACTUAL STATUS SIZES',14,BLUE,True)
for j,size in enumerate([16,20,24,32]):
    x=725+j*85
    paste(board,asset('bloom',f'status-{size}-dark'),(x,1080-size),size)
    text(d,(x,1108),f'{size}px',12,MUTED)
d.rounded_rectangle((1115,1000,1280,1165),12,fill='#EDF3FC')
paste(board,asset('bloom','mono-light'),(1125,1010),145)
text(d,(1128,1180),'One color / light',13,MUTED)
wrap(d,(1360,1010),'Outer contour, opening and light gather at different rates around fixed anchors. The body remains circular and recognizable throughout.',375,20,leading=30)
d.line((50,1235,1750,1235),fill=LINE)
for i,color in enumerate(['#0A101E','#437BFF','#72BEFF','#A7DFFF','#E5F5FF']):
    x=50+i*125;d.rounded_rectangle((x,1268,x+92,1304),7,fill=color,outline=LINE);text(d,(x,1316),color,12,MUTED)
wrap(d,(760,1263),'One continuous organic silhouette. Shape changes provide the motion; light supports the form. No rotation.',970,24,INK,33)
text(d,(50,1360),'Shared-geometry non-browser renders / silent design simulation / no microphone or API / editable SVG masters.',15,MUTED)
board.save(OUT/'overview.png',optimize=True)

frames=[]
for index in range(80):
    im=Image.new('RGB',(1200,520),BG);di=ImageDraw.Draw(im)
    text(di,(28,22),'ORGANIC BLUE / SILENT WORKING SIMULATION',16,BLUE,True)
    text(di,(965,22),f'{index*.04:.2f}s / 3.20s',15,MUTED)
    for i,kind in enumerate(KINDS):
        x=28+i*398;text(di,(x,69),f'0{i+1} / {NAMES[i]}',22)
        paste(im,DATA[kind]['frames'][index],(x+18,116),328)
        text(di,(x+18,462),['Recommended balance','Larger opening','Fuller body'][i],14,MUTED)
    text(di,(28,496),'Outer contour gathers first; opening and light follow. Fixed anchors, no rotation, no audio.',15,MUTED)
    frames.append(im)
atlas=Image.new('RGB',(1200,1560))
for j,index in enumerate([0,35,57]):atlas.paste(frames[index],(0,j*520))
palette=atlas.quantize(colors=256)
indexed=[im.quantize(palette=palette,dither=Image.Dither.FLOYDSTEINBERG) for im in frames]
indexed[0].save(OUT/'working-comparison.gif',save_all=True,append_images=indexed[1:],duration=40,loop=0,optimize=False,disposal=2)

contact=Image.new('RGB',(1800,920),BG);dc=ImageDraw.Draw(contact)
text(dc,(40,25),'ACTUAL GEOMETRY / OPEN, GATHER, RELEASE, SETTLE',23)
for i,kind in enumerate(KINDS):
    y=90+i*270;text(dc,(40,y),NAMES[i],20,BLUE)
    for j,time in enumerate([0,.6,1.1,1.4,2.1,2.8,3.2]):
        x=40+j*250;paste(contact,DATA[kind]['beats'][j],(x,y+35),196);text(dc,(x+64,y+239),f'{time:.2f}s',14,MUTED)
contact.save(OUT/'motion-contact-sheet.png',optimize=True)

sizes=Image.new('RGB',(1600,900),BG);dz=ImageDraw.Draw(sizes)
text(dz,(45,30),'FLUID FIELD / ACTUAL SIZE AND MONO',29)
text(dz,(45,84),'The small mark is a single crisp compound contour with an uneven opening. No glow or tiny moving detail.',19,MUTED)
for theme,x,bg in [('dark',45,PANEL),('light',830,'#EDF3FC')]:
    dz.rounded_rectangle((x,148,x+720,314),14,fill=bg)
    for j,size in enumerate([16,20,24,32]):
        px=x+55+j*160;paste(sizes,asset('bloom',f'status-{size}-{theme}'),(px,242-size),size);text(dz,(px,267),f'{size}px',16,MUTED if theme=='dark' else '#52647C')
    dz.rounded_rectangle((x,339,x+720,397),9,fill=bg)
    paste(sizes,asset('bloom',f'status-16-{theme}'),(x+20,360),16);text(dz,(x+50,359),'Working / design simulation',17,INK if theme=='dark' else '#14263E')
micro=raster(asset('bloom','status-16-dark'),16).resize((240,240),Image.Resampling.NEAREST)
sizes.paste(micro,(45,443),micro);text(dz,(45,705),'16px / 15x pixel proof',16,MUTED)
paste(sizes,asset('bloom','mono-dark'),(385,448),230);text(dz,(390,705),'One color / dark',16,MUTED)
dz.rounded_rectangle((775,443,1050,718),17,fill='#EDF3FC');paste(sizes,asset('bloom','mono-light'),(793,460),240);text(dz,(805,739),'One color / light',16,MUTED)
paste(sizes,asset('bloom','app-icon-light'),(1205,443),275);text(dz,(1208,739),'Light app tile',16,MUTED)
text(dz,(45,835),'Color is surface light, not a state code. Keep exact adjacent status text and use the still micro mark at small sizes.',17,MUTED)
sizes.save(OUT/'sizes-and-use.png',optimize=True)

assets=list((ROOT/'assets').rglob('*.svg'))
for a in assets:assert raster(a.read_text(),128).getbbox(),a
# Transparent master opening must remain open after equivalent clipping, without leaking highlights.
assert raster(asset('bloom','master'),256).getpixel((128,128))[3]<55
gif=Image.open(OUT/'working-comparison.gif');assert gif.n_frames==80 and gif.info['loop']==0
durations=[]
for i in range(gif.n_frames):gif.seek(i);durations.append(gif.info['duration'])
assert durations==[40]*80
gif.seek(0);opened=gif.convert('RGB');gif.seek(35);gathered=gif.convert('RGB')
assert ImageChops.difference(opened.crop((40,110,390,450)),gathered.crop((40,110,390,450))).getbbox()
proof=Image.new('RGB',(1200,1040),BG);proof.paste(opened,(0,0));proof.paste(gathered,(0,520));proof.save(OUT/'gif-decoded-proof.png',optimize=True)
report={'renderer':'PyMuPDF for body, vector light and exact compound mask; equivalent Pillow alpha clipping/composition; no browser',
 'editable_svgs_rendered':len(assets),'gif_frames':gif.n_frames,'gif_duration_ms':sum(durations),'gif_size':[1200,520],
 'clipping':'PyMuPDF ignores SVG clip-path; Pillow applies the exact shared contour mask to vector light layers. Masters use standard SVG clipPath.',
 'outputs':['icon-preview.png','overview.png','working-comparison.gif','motion-contact-sheet.png','sizes-and-use.png','gif-decoded-proof.png'],
 'scope':'Shared geometry and equivalent non-browser light composition; no browser layout, controls, clipPath playback or accessibility acceptance.'}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
