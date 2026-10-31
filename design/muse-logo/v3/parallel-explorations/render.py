"""Broader form and colour study. Shared SVG geometry, no browser/server."""
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
BG,PANEL,LINE,INK,MUTED,ACCENT='#080D15','#111723','#2B3445','#E6F0FF','#A7AFBE','#A1D9EB'
KINDS=['original','fan','crossing','horizon','prism','terrace']
NAMES=['Parallel','Fan','Crossing','Horizon','Prism','Terrace']
PALETTES=['blue','lagoon','violet','ember','pearl','citrine']
PALETTE_NAMES=['Blue','Lagoon','Violet','Ember','Pearl','Citrine']
NOTES=['Selected reference.','Broad planes fan from a common footing.','Independent planes cross through a shared region.','Wide horizontal layers create a new rhythm.','Three surfaces assemble into one volume.','Offset surfaces form a stepped spatial stack.']

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
const P=require('./planes.js'),out={forms:{},colors:{}};for(const k of P.KINDS)out.forms[k]={
 frames:Array.from({length:80},(_,i)=>P.svg(k,{state:'working',time:i*.04,motion:true,tile:true})),
 beats:[0,.65,1.4,2.1,2.8,3.2].map(time=>P.svg(k,{state:'working',time,motion:true,tile:true}))
};for(const c of Object.keys(P.PALETTES))out.colors[c]={svg:P.svg('original',{palette:c,tile:true}),base:P.PALETTES[c].base,ice:P.PALETTES[c].ice};process.stdout.write(JSON.stringify(out));
"""
DATA=json.loads(subprocess.check_output(['node','-e',code],cwd=ROOT,text=True))

# Clear six-card comparison: materially different forms and colours.
sheet=Image.new('RGB',(1500,1180),BG);ds=ImageDraw.Draw(sheet)
text(ds,(40,24),'PARALLEL / BOLDER FORMS + COLOUR',18,ACCENT,True)
text(ds,(40,59),'Reference plus five substantial remixes. Every form can use every palette.',18,MUTED)
for i,kind in enumerate(KINDS):
    x=40+(i%3)*495;y=112+(i//3)*505
    paste(sheet,asset(kind,'app-icon-dark'),(x,y),380)
    text(ds,(x+4,y+403),f'0{i+1} / {NAMES[i]}',27)
    text(ds,(x+4,y+442),PALETTE_NAMES[i],19,ACCENT)
    wrap(ds,(x+4,y+472),NOTES[i],420,16,leading=23)
text(ds,(40,1142),'Six structures × six palettes. The interactive preview lets you combine shape and colour independently.',18,MUTED)
sheet.save(OUT/'comparison.png',optimize=True)

# Same original geometry isolates palette choice from silhouette changes.
colors=Image.new('RGB',(1500,1140),BG);dc=ImageDraw.Draw(colors)
text(dc,(40,25),'COLOUR STUDY / ONE SHAPE, SIX PALETTES',18,ACCENT,True)
text(dc,(40,61),'The original Parallel geometry is unchanged in every tile.',18,MUTED)
for i,palette in enumerate(PALETTES):
    x=40+(i%3)*495;y=109+(i//3)*495
    paste(colors,DATA['colors'][palette]['svg'],(x,y),360)
    text(dc,(x+4,y+384),PALETTE_NAMES[i],27)
    for j,c in enumerate(DATA['colors'][palette]['base']+[DATA['colors'][palette]['ice']]):
        px=x+4+j*72;dc.rounded_rectangle((px,y+428,px+55,y+451),5,fill=c)
text(dc,(40,1100),'Apply these colours to Fan, Crossing, Horizon, Prism or Terrace in the interactive preview.',18,MUTED)
colors.save(OUT/'palette-study.png',optimize=True)

# Detailed overview with the structural idea and actual tiny sizes.
board=Image.new('RGB',(1800,1640),BG);d=ImageDraw.Draw(board)
text(d,(50,35),'PARALLEL / STRUCTURE AND PALETTE EXPLORATIONS',16,ACCENT,True)
text(d,(1385,35),'NAME INDEPENDENT / 1 NOV 2026',14,MUTED)
text(d,(47,85),'Bolder forms. Broader colour.',75)
text(d,(50,184),'Three work surfaces, recomposed as fans, crossings, horizontal layers, a prism and terraces.',24,MUTED)
for i,kind in enumerate(KINDS):
    x=50+(i%3)*575;y=248+(i//3)*640
    d.rounded_rectangle((x,y,x+550,y+614),18,fill=PANEL,outline=LINE)
    text(d,(x+24,y+22),f'0{i+1} / '+('SELECTED REFERENCE' if i==0 else 'STRUCTURAL REMIX'),14,ACCENT,True)
    paste(board,asset(kind,'app-icon-dark'),(x+125,y+61),300)
    text(d,(x+24,y+383),f'{NAMES[i]} / {PALETTE_NAMES[i]}',31)
    wrap(d,(x+24,y+432),NOTES[i],490,21,leading=29)
    d.line((x+24,y+512,x+526,y+512),fill=LINE)
    text(d,(x+24,y+538),'Actual px',12,MUTED)
    for j,size in enumerate([16,20,24,32]):
        px=x+150+j*91;paste(board,asset(kind,f'status-{size}-dark'),(px,y+563-size),size);text(d,(px,y+579),str(size),11,MUTED)
text(d,(50,1544),'The relationship stays consistent: independent work surfaces coordinate around a stable primary surface.',23,INK)
text(d,(50,1594),'Editable SVGs for all 36 combinations. Shared-geometry non-browser renders. No new image generation, mic, API or app integration.',15,MUTED)
board.save(OUT/'overview.png',optimize=True)

(OUT/'icons').mkdir(exist_ok=True)
for kind in KINDS:
    im=Image.new('RGB',(600,600),BG);paste(im,asset(kind,'app-icon-dark'),(30,30),540);im.save(OUT/'icons'/(kind+'.png'),optimize=True)

frames=[]
for index in range(80):
    im=Image.new('RGB',(1080,930),BG);di=ImageDraw.Draw(im)
    text(di,(25,18),'PARALLEL / SILENT FORM + COLOUR SIMULATIONS',15,ACCENT,True)
    text(di,(854,18),f'{index*.04:.2f}s / 3.20s',14,MUTED)
    for i,kind in enumerate(KINDS):
        x=25+(i%3)*355;y=66+(i//3)*406
        text(di,(x,y),f'0{i+1} / {NAMES[i]}',20)
        paste(im,DATA['forms'][kind]['frames'][index],(x+17,y+41),285)
        text(di,(x+17,y+343),PALETTE_NAMES[i],13,MUTED)
    text(di,(25,893),'Three surfaces gather and open around a stable primary plane. One 3.2s clock. No audio or live state.',14,MUTED)
    frames.append(im)
atlas=Image.new('RGB',(1080,2790))
for j,index in enumerate([0,35,58]):atlas.paste(frames[index],(0,j*930))
palette=atlas.quantize(colors=256)
indexed=[im.quantize(palette=palette,dither=Image.Dither.FLOYDSTEINBERG) for im in frames]
indexed[0].save(OUT/'working-comparison.gif',save_all=True,append_images=indexed[1:],duration=40,loop=0,optimize=False,disposal=2)

contact=Image.new('RGB',(1560,1770),BG);dd=ImageDraw.Draw(contact)
text(dd,(35,25),'STRUCTURAL MOTION / REST, GATHER, OPEN, SETTLE',23)
for i,kind in enumerate(KINDS):
    y=90+i*275;text(dd,(35,y),f'0{i+1} / {NAMES[i]}',20,ACCENT)
    for j,time in enumerate([0,.65,1.4,2.1,2.8,3.2]):
        x=35+j*250;paste(contact,DATA['forms'][kind]['beats'][j],(x,y+32),190);text(dd,(x+57,y+235),f'{time:.2f}s',14,MUTED)
contact.save(OUT/'motion-contact-sheet.png',optimize=True)

sizes=Image.new('RGB',(1800,1190),BG);dz=ImageDraw.Draw(sizes)
text(dz,(40,28),'NEW FORMS / ACTUAL SIZES, LIGHT AND MONO',28)
text(dz,(40,80),'16 / 20 / 24 / 32px are real pixels. Small art keeps three flat surfaces and omits material effects.',19,MUTED)
for i,kind in enumerate(KINDS):
    x=40+(i%3)*590;y=145+(i//3)*505
    text(dz,(x,y),f'0{i+1} / {NAMES[i]} · {PALETTE_NAMES[i]}',22,ACCENT)
    for theme,dy,bg in [('dark',47,PANEL),('light',158,'#EDF3FC')]:
        yy=y+dy;dz.rounded_rectangle((x,yy,x+550,yy+96),10,fill=bg)
        for j,size in enumerate([16,20,24,32]):
            px=x+40+j*126;paste(sizes,asset(kind,f'status-{size}-{theme}'),(px,yy+53-size),size);text(dz,(px,yy+69),f'{size}px',12,MUTED if theme=='dark' else '#52647C')
    micro=raster(asset(kind,'status-16-dark'),16).resize((96,96),Image.Resampling.NEAREST);sizes.paste(micro,(x+8,y+288),micro);text(dz,(x+8,y+402),'16px / 6x',12,MUTED)
    paste(sizes,asset(kind,'mono-dark'),(x+143,y+277),110);text(dz,(x+148,y+402),'One color',12,MUTED)
    dz.rounded_rectangle((x+286,y+278,x+396,y+388),9,fill='#EDF3FC');paste(sizes,asset(kind,'mono-light'),(x+291,y+283),100);text(dz,(x+290,y+402),'Ink',12,MUTED)
    paste(sizes,asset(kind,'app-icon-light'),(x+423,y+278),110);text(dz,(x+428,y+402),'Light tile',12,MUTED)
text(dz,(40,1160),'Colour is an identity palette, not a state code. Keep exact status in adjacent text. Light surfaces use deeper body tones.',16,MUTED)
sizes.save(OUT/'sizes-and-use.png',optimize=True)

baseline=raster((ROOT.parent/'reset/assets/parallel/app-icon-dark.svg').read_text(),256)
current=raster(asset('original','app-icon-dark'),256)
maxima=[hi for lo,hi in ImageChops.difference(baseline,current).getextrema()]
assert maxima==[0,0,0,0],maxima
assets=list((ROOT/'assets').rglob('*.svg'))
for p in assets:assert raster(p.read_text(),128).getbbox(),p
gif=Image.open(OUT/'working-comparison.gif');assert gif.n_frames==80 and gif.info['loop']==0
durations=[]
for i in range(gif.n_frames):gif.seek(i);durations.append(gif.info['duration'])
assert durations==[40]*80
gif.seek(0);opened=gif.convert('RGB');gif.seek(35);gathered=gif.convert('RGB')
for i in range(6):
    x=25+(i%3)*355+17;y=66+(i//3)*406+41
    assert ImageChops.difference(opened.crop((x,y,x+285,y+285)),gathered.crop((x,y,x+285,y+285))).getbbox()
proof=Image.new('RGB',(1080,1860),BG);proof.paste(opened,(0,0));proof.paste(gathered,(0,930));proof.save(OUT/'gif-decoded-proof.png',optimize=True)
report={'renderer':'PyMuPDF exact surfaces; Pillow equivalent SVG radial-gradient stops, transforms and clipping; no browser',
 'editable_svgs_rendered':len(assets),'form_palette_master_combinations':36,'gif_frames':gif.n_frames,'gif_duration_ms':sum(durations),'gif_size':[1080,930],
 'reference_original_blue_RGBA_max_difference':maxima,'new_image_generation':False,
 'outputs':['comparison.png','palette-study.png','overview.png','working-comparison.gif','motion-contact-sheet.png','sizes-and-use.png','gif-decoded-proof.png','icons/{original,fan,crossing,horizon,prism,terrace}.png'],
 'scope':'Shared-geometry non-browser renders and decoded GIF checks. Browser layout, native controls/gradients/clipping/playback and accessibility are unverified.'}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
