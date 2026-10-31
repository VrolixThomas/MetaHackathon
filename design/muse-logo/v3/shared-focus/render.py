"""Shared-pose artwork and motion, rendered without a browser."""
from pathlib import Path
import sys
sys.dont_write_bytecode=True
import json
import subprocess
from PIL import Image,ImageDraw,ImageFont,ImageChops
from raster import raster

ROOT=Path(__file__).resolve().parent
OUT=ROOT/'renders'
OUT.mkdir(exist_ok=True)
BG,PANEL,LINE,INK,MUTED,BLUE='#070C16','#0D1524','#26334A','#E6F0FF','#9DAEC8','#83C5FF'

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

def asset(name):return (ROOT/'assets'/(name+'.svg')).read_text()

code="""
const S=require('./focus.js');process.stdout.write(JSON.stringify({
frames:Array.from({length:80},(_,i)=>S.svg({state:'working',time:i*.04,motion:true,tile:true})),
beats:[0,.4,.8,1.2,1.4,2.1,2.8,3.2].map(time=>S.svg({state:'working',time,motion:true,tile:true}))
}));
"""
DATA=json.loads(subprocess.check_output(['node','-e',code],cwd=ROOT,text=True))

hero=Image.new('RGB',(720,720),BG);paste(hero,asset('app-icon-dark'),(40,40),640);hero.save(OUT/'icon-preview.png',optimize=True)

# Concept and hierarchy lead the board; every visible addition has a role.
board=Image.new('RGB',(1800,1420),BG);d=ImageDraw.Draw(board)
text(d,(50,35),'IDENTITY STUDY / SHARED FOCUS',16,BLUE,True)
text(d,(1370,35),'NAME INDEPENDENT / 31 OCT 2026',14,MUTED)
text(d,(47,87),'One conversation. Many threads.',74)
text(d,(50,181),'Independent work comes together in shared context, then reaches your attention.',25,MUTED)
d.rounded_rectangle((50,243,755,941),20,fill=PANEL,outline=LINE)
paste(board,asset('app-icon-dark'),(95,282),615)
text(d,(82,910),'SHARED FOCUS / CIRCULAR, ORGANIC, BLUE',14,BLUE,True)

legend=[
    ('Separate threads','Independent work, incoming information and questions. They arrive on their own paths and enter the shared field.','#72BEFF'),
    ('Context held together','The blue body holds the relationship between those threads, so one conversation can keep the whole work moving.','#437BFF'),
    ('Your current focus','The steady ice-blue junction is where context becomes a useful answer, decision or next step for you.','#E5F5FF')
]
for i,(title,copy,color) in enumerate(legend):
    y=291+i*191
    if i==1:
        d.ellipse((810,y+6,850,y+46),fill=color);d.ellipse((820,y+16,840,y+36),fill=BG)
    else:
        radius=10 if i==0 else 16;d.ellipse((830-radius,y+25-radius,830+radius,y+25+radius),fill=color)
    text(d,(880,y),title,30)
    wrap(d,(880,y+51),copy,830,23,leading=33)
wrap(d,(810,861),'The junction is part of the field’s opening. Activity gathers toward it; your point of attention stays steady.',900,23,INK,33)

text(d,(50,984),'THE MOTION TELLS THE SAME STORY',14,BLUE,True)
for j,index in enumerate([0,4,7]):
    x=50+j*225;paste(board,DATA['beats'][index],(x,1027),190)
    text(d,(x+3,1229),['Independent threads','Context gathers','Space opens again'][j],14,MUTED)
text(d,(835,984),'ACTUAL STATUS SIZES',14,BLUE,True)
for j,size in enumerate([16,20,24,32]):
    x=840+j*85;paste(board,asset(f'status-{size}-dark'),(x,1111-size),size);text(d,(x,1142),f'{size}px',12,MUTED)
d.rounded_rectangle((1270,1030,1450,1210),13,fill='#EDF3FC');paste(board,asset('mono-light'),(1280,1040),160);text(d,(1282,1228),'One color / light',13,MUTED)
wrap(d,(1505,1040),'Micro art retains the context and junction. Remote signals and fine routes are omitted.',245,18,leading=27)
d.line((50,1290,1750,1290),fill=LINE)
text(d,(50,1320),'THE VISION',14,BLUE,True)
text(d,(260,1313),'One conversation keeps your whole work moving.',31)
text(d,(50,1380),'Original editable geometry / silent working simulation / non-browser shared-pose renders / no microphone or API.',15,MUTED)
board.save(OUT/'overview.png',optimize=True)

# One concept, with its meaning alongside the actual motion.
frames=[]
for index in range(80):
    im=Image.new('RGB',(1050,660),BG);di=ImageDraw.Draw(im)
    text(di,(28,22),'SHARED FOCUS / SILENT WORKING SIMULATION',16,BLUE,True)
    text(di,(830,22),f'{index*.04:.2f}s / 3.20s',15,MUTED)
    paste(im,DATA['frames'][index],(28,87),500)
    for i,(title,copy,color) in enumerate(legend):
        y=125+i*142;di.ellipse((582,y+8,596,y+22),fill=color)
        text(di,(615,y),title,23);wrap(di,(615,y+39),['Arriving independently.','Held in one coherent field.','A steady point of attention.'][i],370,18,leading=27)
    text(di,(28,620),'Threads gather into context. Context gathers toward your focus. No rotation or audio.',16,MUTED)
    frames.append(im)
atlas=Image.new('RGB',(1050,1980))
for j,index in enumerate([0,35,58]):atlas.paste(frames[index],(0,j*660))
palette=atlas.quantize(colors=256)
indexed=[im.quantize(palette=palette,dither=Image.Dither.FLOYDSTEINBERG) for im in frames]
indexed[0].save(OUT/'working.gif',save_all=True,append_images=indexed[1:],duration=40,loop=0,optimize=False,disposal=2)

contact=Image.new('RGB',(1800,395),BG);dc=ImageDraw.Draw(contact)
text(dc,(35,24),'INDEPENDENT THREADS / SHARED CONTEXT / FIXED FOCUS',23)
for j,time in enumerate([0,.4,.8,1.2,1.4,2.1,2.8,3.2]):
    x=35+j*220;paste(contact,DATA['beats'][j],(x,81),190);text(dc,(x+58,291),f'{time:.2f}s',14,MUTED)
text(dc,(35,349),'The incoming lights are absorbed into the body while its blue context gathers toward the steady ice-blue junction.',17,MUTED)
contact.save(OUT/'motion-contact-sheet.png',optimize=True)

sizes=Image.new('RGB',(1600,880),BG);dz=ImageDraw.Draw(sizes)
text(dz,(45,30),'SHARED FOCUS / ACTUAL SIZE AND MONO',29)
text(dz,(45,84),'The small mark keeps the context and focus. Fine routes and distant signals simplify away.',19,MUTED)
for theme,x,bg in [('dark',45,PANEL),('light',830,'#EDF3FC')]:
    dz.rounded_rectangle((x,148,x+720,314),14,fill=bg)
    for j,size in enumerate([16,20,24,32]):
        px=x+55+j*160;paste(sizes,asset(f'status-{size}-{theme}'),(px,242-size),size);text(dz,(px,267),f'{size}px',16,MUTED if theme=='dark' else '#52647C')
    dz.rounded_rectangle((x,339,x+720,397),9,fill=bg);paste(sizes,asset(f'status-16-{theme}'),(x+20,360),16);text(dz,(x+50,359),'Working / design simulation',17,INK if theme=='dark' else '#14263E')
micro=raster(asset('status-16-dark'),16).resize((240,240),Image.Resampling.NEAREST);sizes.paste(micro,(45,443),micro);text(dz,(45,705),'16px / 15x proof',16,MUTED)
paste(sizes,asset('mono-dark'),(385,448),230);text(dz,(390,705),'One color / dark',16,MUTED)
dz.rounded_rectangle((775,443,1050,718),17,fill='#EDF3FC');paste(sizes,asset('mono-light'),(793,460),240);text(dz,(805,739),'One color / light',16,MUTED)
paste(sizes,asset('app-icon-light'),(1205,443),275);text(dz,(1208,739),'Light app tile',16,MUTED)
text(dz,(45,825),'The junction is part of the identity, not a status badge. Exact state stays in adjacent text.',17,MUTED)
sizes.save(OUT/'sizes-and-use.png',optimize=True)

assets=list((ROOT/'assets').rglob('*.svg'))
for a in assets:assert raster(a.read_text(),128).getbbox(),a
gif=Image.open(OUT/'working.gif');assert gif.n_frames==80 and gif.info['loop']==0
durations=[]
for i in range(gif.n_frames):gif.seek(i);durations.append(gif.info['duration'])
assert durations==[40]*80
gif.seek(0);opened=gif.convert('RGB');gif.seek(35);gathered=gif.convert('RGB')
assert ImageChops.difference(opened.crop((28,87,528,587)),gathered.crop((28,87,528,587))).getbbox()
proof=Image.new('RGB',(1050,1320),BG);proof.paste(opened,(0,0));proof.paste(gathered,(0,660));proof.save(OUT/'gif-decoded-proof.png',optimize=True)
report={'renderer':'Exact shared geometry, PyMuPDF vector layers and equivalent Pillow alpha clipping; no browser',
 'editable_svgs_rendered':len(assets),'gif_frames':gif.n_frames,'gif_duration_ms':sum(durations),'gif_size':[1050,660],
 'layer_order':'Signal intake routes and lights behind context; fixed foreground junction above context.',
 'clipping':'Standard SVG clipPath in masters/HTML; equivalent shared-contour Pillow mask for non-browser renders because PyMuPDF ignores clip-path.',
 'outputs':['icon-preview.png','overview.png','working.gif','motion-contact-sheet.png','sizes-and-use.png','gif-decoded-proof.png'],
 'scope':'Non-browser renders and decoded GIF frames; browser layout, actual controls/playback, clipping and accessibility remain unverified.'}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
