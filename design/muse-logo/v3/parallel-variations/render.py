"""Six controlled Parallel variations, rendered without browser or server."""
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
KINDS=['original','compact','open','aligned','soft','level']
NAMES=['Original','Compact','Open','Aligned','Rounded','Level']
NOTES=['The approved Parallel reference.','Tighter offsets; denser and more unified.','More separation; the three surfaces read clearly.','A taller rear surface shares the lower edge.','Rounder corners on the same three surfaces.','A shallower angle; calmer and more front-facing.']

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
const P=require('./parallel.js'),out={};for(const k of P.KINDS)out[k]={
 frames:Array.from({length:80},(_,i)=>P.svg(k,{state:'working',time:i*.04,motion:true,tile:true})),
 beats:[0,.65,1.4,2.1,2.8,3.2].map(time=>P.svg(k,{state:'working',time,motion:true,tile:true}))
};process.stdout.write(JSON.stringify(out));
"""
DATA=json.loads(subprocess.check_output(['node','-e',code],cwd=ROOT,text=True))

# Compact comparison for immediate visual feedback.
sheet=Image.new('RGB',(1500,1130),BG);ds=ImageDraw.Draw(sheet)
text(ds,(40,24),'PARALLEL / ORIGINAL + FIVE VARIATIONS',17,BLUE,True)
for i,kind in enumerate(KINDS):
    x=40+(i%3)*495;y=84+(i//3)*500
    paste(sheet,asset(kind,'app-icon-dark'),(x,y),380)
    text(ds,(x+4,y+404),f'0{i+1} / {NAMES[i]}',26)
    wrap(ds,(x+4,y+445),NOTES[i],425,18,leading=25)
text(ds,(40,1091),'Same blue palette and light material. Variations change spacing, proportion, corners or viewing angle.',18,MUTED)
sheet.save(OUT/'comparison.png',optimize=True)

# Larger board adds true-size glyphs, while keeping the same camera, scale and lighting.
board=Image.new('RGB',(1800,1610),BG);d=ImageDraw.Draw(board)
text(d,(50,35),'PARALLEL / CONTROLLED REFINEMENTS',16,BLUE,True)
text(d,(1395,35),'NAME INDEPENDENT / 1 NOV 2026',14,MUTED)
text(d,(47,85),'Parallel, refined.',80)
text(d,(50,184),'The selected direction, with five variations in spacing, proportion, corners and angle.',25,MUTED)
for i,kind in enumerate(KINDS):
    x=50+(i%3)*575;y=248+(i//3)*630
    d.rounded_rectangle((x,y,x+550,y+604),18,fill=PANEL,outline=LINE)
    text(d,(x+24,y+22),f'0{i+1} / '+('APPROVED REFERENCE' if i==0 else 'VARIATION'),14,BLUE,True)
    paste(board,asset(kind,'app-icon-dark'),(x+125,y+62),300)
    text(d,(x+24,y+382),NAMES[i],34)
    wrap(d,(x+24,y+434),NOTES[i],490,21,leading=29)
    d.line((x+24,y+510,x+526,y+510),fill=LINE)
    text(d,(x+24,y+535),'Actual px',12,MUTED)
    for j,size in enumerate([16,20,24,32]):
        px=x+150+j*91;paste(board,asset(kind,f'status-{size}-dark'),(px,y+560-size),size);text(d,(px,y+575),str(size),11,MUTED)
text(d,(50,1524),'One identity family: independent work surfaces, a stable foreground and a shared orientation.',24,INK)
text(d,(50,1571),'Editable vector refinements. Shared-geometry non-browser renders. No new image generation, mic, API or app integration.',15,MUTED)
board.save(OUT/'overview.png',optimize=True)

# Individual app-icon PNGs are convenient for manual review without SVG/browser support.
(OUT/'icons').mkdir(exist_ok=True)
for kind in KINDS:
    im=Image.new('RGB',(600,600),BG);paste(im,asset(kind,'app-icon-dark'),(30,30),540);im.save(OUT/'icons'/(kind+'.png'),optimize=True)

frames=[]
for index in range(80):
    im=Image.new('RGB',(1080,900),BG);di=ImageDraw.Draw(im)
    text(di,(25,18),'PARALLEL / SILENT WORKING SIMULATIONS',15,BLUE,True)
    text(di,(854,18),f'{index*.04:.2f}s / 3.20s',14,MUTED)
    for i,kind in enumerate(KINDS):
        x=25+(i%3)*355;y=66+(i//3)*392
        text(di,(x,y),f'0{i+1} / {NAMES[i]}',20)
        paste(im,DATA[kind]['frames'][index],(x+17,y+41),285)
    text(di,(25,861),'Foreground held steady; rear surfaces gather, open and settle. Same 3.2s clock. No audio or live state.',14,MUTED)
    frames.append(im)
atlas=Image.new('RGB',(1080,2700))
for j,index in enumerate([0,35,58]):atlas.paste(frames[index],(0,j*900))
palette=atlas.quantize(colors=256)
indexed=[im.quantize(palette=palette,dither=Image.Dither.NONE) for im in frames]
indexed[0].save(OUT/'working-comparison.gif',save_all=True,append_images=indexed[1:],duration=40,loop=0,optimize=False,disposal=2)

contact=Image.new('RGB',(1560,1770),BG);dc=ImageDraw.Draw(contact)
text(dc,(35,25),'PARALLEL / REST, GATHER, OPEN, SETTLE',23)
for i,kind in enumerate(KINDS):
    y=90+i*275;text(dc,(35,y),f'0{i+1} / {NAMES[i]}',20,BLUE)
    for j,time in enumerate([0,.65,1.4,2.1,2.8,3.2]):
        x=35+j*250;paste(contact,DATA[kind]['beats'][j],(x,y+32),190);text(dc,(x+57,y+235),f'{time:.2f}s',14,MUTED)
contact.save(OUT/'motion-contact-sheet.png',optimize=True)

sizes=Image.new('RGB',(1800,1190),BG);dz=ImageDraw.Draw(sizes)
text(dz,(40,28),'PARALLEL / ACTUAL SIZES, LIGHT AND MONO',28)
text(dz,(40,80),'16 / 20 / 24 / 32px are shown at their real pixel sizes. The enlarged proof uses nearest-neighbor pixels.',19,MUTED)
for i,kind in enumerate(KINDS):
    x=40+(i%3)*590;y=145+(i//3)*505
    text(dz,(x,y),f'0{i+1} / {NAMES[i]}',23,BLUE)
    for theme,dy,bg in [('dark',47,PANEL),('light',158,'#EDF3FC')]:
        yy=y+dy;dz.rounded_rectangle((x,yy,x+550,yy+96),10,fill=bg)
        for j,size in enumerate([16,20,24,32]):
            px=x+40+j*126;paste(sizes,asset(kind,f'status-{size}-{theme}'),(px,yy+53-size),size);text(dz,(px,yy+69),f'{size}px',12,MUTED if theme=='dark' else '#52647C')
    micro=raster(asset(kind,'status-16-dark'),16).resize((96,96),Image.Resampling.NEAREST);sizes.paste(micro,(x+8,y+288),micro);text(dz,(x+8,y+402),'16px / 6x',12,MUTED)
    paste(sizes,asset(kind,'mono-dark'),(x+143,y+277),110);text(dz,(x+148,y+402),'One color',12,MUTED)
    dz.rounded_rectangle((x+286,y+278,x+396,y+388),9,fill='#EDF3FC');paste(sizes,asset(kind,'mono-light'),(x+291,y+283),100);text(dz,(x+290,y+402),'Ink',12,MUTED)
    paste(sizes,asset(kind,'app-icon-light'),(x+423,y+278),110);text(dz,(x+428,y+402),'Light tile',12,MUTED)
text(dz,(40,1160),'Small art uses clear flat shapes and open spacing. Keep exact status in adjacent text; material depth is reserved for larger sizes.',16,MUTED)
sizes.save(OUT/'sizes-and-use.png',optimize=True)

# Confirm the original really is the approved source, including RGB channels.
reference_root=ROOT.parent/'reset/assets/parallel'
baseline={}
for new,old,size in [('app-icon-dark','app-icon-dark',256),('gathered','compact',256),('status-16-dark','status-16-dark',16)]:
    a=raster((reference_root/(old+'.svg')).read_text(),size);b=raster(asset('original',new),size)
    maxima=[hi for lo,hi in ImageChops.difference(a,b).getextrema()]
    assert maxima==[0,0,0,0],(new,maxima)
    baseline[new]={'size':size,'RGBA_max_difference':maxima}

assets=list((ROOT/'assets').rglob('*.svg'))
for p in assets:assert raster(p.read_text(),128).getbbox(),p
gif=Image.open(OUT/'working-comparison.gif');assert gif.n_frames==80 and gif.info['loop']==0
durations=[]
for i in range(gif.n_frames):gif.seek(i);durations.append(gif.info['duration'])
assert durations==[40]*80
gif.seek(0);opened=gif.convert('RGB');gif.seek(35);gathered=gif.convert('RGB')
for i in range(6):
    x=25+(i%3)*355+17;y=66+(i//3)*392+41
    assert ImageChops.difference(opened.crop((x,y,x+285,y+285)),gathered.crop((x,y,x+285,y+285))).getbbox()
proof=Image.new('RGB',(1080,1800),BG);proof.paste(opened,(0,0));proof.paste(gathered,(0,900));proof.save(OUT/'gif-decoded-proof.png',optimize=True)
report={'renderer':'PyMuPDF exact surfaces; Pillow equivalent SVG gradient stops, transforms and clipping; no browser',
 'editable_svgs_rendered':len(assets),'gif_frames':gif.n_frames,'gif_duration_ms':sum(durations),'gif_size':[1080,900],
 'approved_reference':baseline,'new_image_generation':False,
 'outputs':['comparison.png','overview.png','working-comparison.gif','motion-contact-sheet.png','sizes-and-use.png','gif-decoded-proof.png','icons/{original,compact,open,aligned,soft,level}.png'],
 'scope':'Shared-geometry non-browser renders and decoded GIF checks. Browser layout, native controls/gradients/clipping/playback and accessibility remain unverified.'}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
