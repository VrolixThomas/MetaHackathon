"""Focus theme: one clear item, active background, sequential handoff. No browser."""
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
BG,PANEL,LINE,INK,MUTED,ACCENT='#080D15','#111723','#2B3445','#E6F0FF','#A7AFBE','#B6DFF2'
KINDS=['plane','pull','stage']
NAMES=['Focus plane','Pull forward','Focus stage']
NOTES=['One broad review surface holds the foreground; ongoing work stays quieter behind it.','One item separates from a working fan and comes forward for review or discussion.','One clear surface is elevated above a quieter stack of ongoing work.']

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
const F=require('./focus.js'),out={forms:{},palettes:{}};for(const k of F.KINDS)out.forms[k]={
 frames:Array.from({length:192},(_,i)=>F.svg(k,{auto:true,motion:true,time:i*.05,tile:true})),
 steps:[0,.25,.5,.75,1].map(transition=>F.svg(k,{transition,tile:true})),
 holds:[0,1.2,2.2].map(time=>F.svg(k,{focusIndex:0,time,motion:true,tile:false}))
};for(const c of Object.keys(F.PALETTES))out.palettes[c]=F.svg('plane',{palette:c,tile:true});
out.labels=Array.from({length:192},(_,i)=>F.tour(i*.05));process.stdout.write(JSON.stringify(out));
"""
DATA=json.loads(subprocess.check_output(['node','-e',code],cwd=ROOT,text=True))

hero=Image.new('RGB',(720,720),BG);paste(hero,asset('plane','app-icon-dark'),(40,40),640);hero.save(OUT/'focus-preview.png',optimize=True)

# Three focus layouts, same palette and rendering scale.
compare=Image.new('RGB',(1500,650),BG);dd=ImageDraw.Draw(compare)
text(dd,(35,24),'FOCUS / ONE CLEAR ITEM, ONGOING WORK BEHIND',18,ACCENT,True)
for i,kind in enumerate(KINDS):
    x=35+i*495;paste(compare,asset(kind,'app-icon-dark'),(x,82),400)
    text(dd,(x+4,510),f'0{i+1} / {NAMES[i]}',28)
    wrap(dd,(x+4,555),NOTES[i],420,18,leading=26)
compare.save(OUT/'comparison.png',optimize=True)

board=Image.new('RGB',(1800,1480),BG);d=ImageDraw.Draw(board)
text(d,(50,35),'FOCUS / IDENTITY AND SELECTIVE ATTENTION',16,ACCENT,True)
text(d,(1390,35),'NAME INDEPENDENT / 1 NOV 2026',14,MUTED)
text(d,(47,83),'Everything keeps moving.',76)
text(d,(47,171),'One item comes into focus.',76)
text(d,(50,277),'Background work continues. The foreground holds one item for review or conversation.',24,MUTED)
for i,kind in enumerate(KINDS):
    x=50+i*575;y=337
    d.rounded_rectangle((x,y,x+550,y+668),18,fill=PANEL,outline=LINE)
    text(d,(x+24,y+22),f'0{i+1} / '+('RECOMMENDED' if i==0 else 'CLOSE ALTERNATIVE'),14,ACCENT,True)
    paste(board,asset(kind,'app-icon-dark'),(x+115,y+63),320)
    text(d,(x+24,y+413),NAMES[i],34)
    wrap(d,(x+24,y+465),NOTES[i],490,21,leading=29)
    d.line((x+24,y+560,x+526,y+560),fill=LINE)
    text(d,(x+24,y+590),'Actual px',12,MUTED)
    for j,size in enumerate([16,20,24,32]):
        px=x+150+j*91;paste(board,asset(kind,f'status-{size}-dark'),(px,y+615-size),size);text(d,(px,y+631),str(size),11,MUTED)
text(d,(50,1044),'ATTENTION TRANSFERS TO THE NEXT ITEM',14,ACCENT,True)
for j,label in enumerate(['Hold item 1','Let it recede','Quiet handoff','Next comes forward','Hold item 2']):
    x=50+j*237;paste(board,DATA['forms']['plane']['steps'][j],(x,1090),180);text(d,(x+2,1286),label,14,MUTED)
wrap(d,(1310,1114),'One selected surface holds steady until you move on. Other work remains active in the background.',420,24,INK,35)
wrap(d,(1310,1263),'The loop illustrates a handoff. It does not propose automatic review advancement.',420,18,MUTED,27)
d.line((50,1375,1750,1375),fill=LINE)
text(d,(50,1408),'Many things handled. One thing worth your attention.',29,INK)
text(d,(50,1450),'Editable vector layouts / silent simulated handoff / no mic, provider, real work items or app integration.',15,MUTED)
board.save(OUT/'overview.png',optimize=True)

# Restrained palette alternatives keep the same hierarchy and form.
colors=Image.new('RGB',(1500,590),BG);dc=ImageDraw.Draw(colors)
text(dc,(35,24),'FOCUS PLANE / THREE CALM PALETTES',18,ACCENT,True)
for i,(palette,name) in enumerate([('blue','Blue / Ice'),('lagoon','Lagoon'),('pearl','Pearl')]):
    x=35+i*495;paste(colors,DATA['palettes'][palette],(x,80),400);text(dc,(x+4,512),name,28)
text(dc,(35,558),'The same single-focus hierarchy holds across all palettes.',17,MUTED)
colors.save(OUT/'palette-study.png',optimize=True)

# A 9.6s illustration: hold 2.4s, hand off .8s, then hold the next item.
frames=[]
for index in range(192):
    im=Image.new('RGB',(1200,590),BG);di=ImageDraw.Draw(im);state=DATA['labels'][index]
    text(di,(28,21),'FOCUS HANDOFF / SILENT DESIGN COMPARISON',16,ACCENT,True)
    label=f"Holding illustrative item {state['focusIndex']+1}" if state['transition']==0 else f"Bringing illustrative item {(state['focusIndex']+1)%3+1} forward"
    text(di,(28,58),label,22)
    text(di,(976,24),f'{index*.05:.2f}s / 9.60s',14,MUTED)
    for i,kind in enumerate(KINDS):
        x=28+i*398;text(di,(x,108),f'0{i+1} / {NAMES[i]}',20)
        paste(im,DATA['forms'][kind]['frames'][index],(x+18,151),320)
    text(di,(28,507),'One clear foreground. Quieter work continues behind it. The same focus position passes between items.',15,MUTED)
    text(di,(28,551),'Illustrative loop only. The interactive preview holds focus until Next by default; automatic review navigation is not implied.',13,MUTED)
    frames.append(im)
atlas=Image.new('RGB',(1200,1770))
for j,index in enumerate([0,61,125]):atlas.paste(frames[index],(0,j*590))
palette=atlas.quantize(colors=256)
indexed=[im.quantize(palette=palette,dither=Image.Dither.NONE) for im in frames]
indexed[0].save(OUT/'focus-handoff.gif',save_all=True,append_images=indexed[1:],duration=50,loop=0,optimize=False,disposal=2)

contact=Image.new('RGB',(1560,955),BG);de=ImageDraw.Draw(contact)
text(de,(35,24),'SAME FOREGROUND POSITION / ONE ITEM AT A TIME',23)
for i,kind in enumerate(KINDS):
    y=90+i*280;text(de,(35,y),NAMES[i],20,ACCENT)
    for j,transition in enumerate([0,.2,.4,.6,.8,1]):
        # Generate these exact intermediate poses rather than approximating from the movie.
        svg=subprocess.check_output(['node','-e',f"const F=require('./focus.js');process.stdout.write(F.svg('{kind}',{{transition:{transition},tile:true}}));"],cwd=ROOT,text=True)
        x=35+j*250;paste(contact,svg,(x,y+34),192);text(de,(x+35,y+244),f'Progress {transition:.1f}',14,MUTED)
contact.save(OUT/'handoff-contact-sheet.png',optimize=True)

sizes=Image.new('RGB',(1650,970),BG);dz=ImageDraw.Draw(sizes)
text(dz,(40,28),'FOCUS / ACTUAL SIZES, LIGHT AND MONO',28)
text(dz,(40,80),'16 / 20 / 24 / 32px are real pixels. One filled focus surface; background structure remains present.',19,MUTED)
for i,kind in enumerate(KINDS):
    x=40+i*540;text(dz,(x,139),NAMES[i],25,ACCENT)
    for theme,y,bg in [('dark',190,PANEL),('light',330,'#EDF3F7')]:
        dz.rounded_rectangle((x,y,x+510,y+115),11,fill=bg)
        for j,size in enumerate([16,20,24,32]):
            px=x+40+j*115;paste(sizes,asset(kind,f'status-{size}-{theme}'),(px,y+60-size),size);text(dz,(px,y+82),f'{size}px',13,MUTED if theme=='dark' else '#52647C')
    for theme,y,bg in [('dark',470,PANEL),('light',528,'#EDF3F7')]:
        dz.rounded_rectangle((x,y,x+510,y+42),7,fill=bg);paste(sizes,asset(kind,f'status-16-{theme}'),(x+13,y+13),16);text(dz,(x+41,y+12),'Focus held / design simulation',14,INK if theme=='dark' else '#172B3C')
    micro=raster(asset(kind,'status-16-dark'),16).resize((144,144),Image.Resampling.NEAREST);sizes.paste(micro,(x+8,620),micro);text(dz,(x+8,785),'16px / 9x proof',14,MUTED)
    paste(sizes,asset(kind,'mono-dark'),(x+173,616),150);text(dz,(x+181,785),'One color',14,MUTED)
    paste(sizes,asset(kind,'app-icon-light'),(x+349,608),155);text(dz,(x+354,785),'Light tile',14,MUTED)
text(dz,(40,885),'The focus hierarchy survives without glow: a solid foreground and outlined or quieter background surfaces.',18,INK)
text(dz,(40,927),'State stays in adjacent text. This is a logo study, not a live work queue.',16,MUTED)
sizes.save(OUT/'sizes-and-use.png',optimize=True)

# All delivered SVGs have actual raster output.
assets=list((ROOT/'assets').rglob('*.svg'))
for p in assets:assert raster(p.read_text(),128).getbbox(),p
# Foreground geometry/light are physically stable while the background keeps working.
held=[raster(s,256).convert('RGB') for s in DATA['forms']['plane']['holds']]
for im in held[1:]:assert ImageChops.difference(held[0].crop((95,105,139,155)),im.crop((95,105,139,155))).getbbox() is None
assert ImageChops.difference(held[0],held[1]).getbbox() is not None
gif=Image.open(OUT/'focus-handoff.gif');assert gif.n_frames==192 and gif.info['loop']==0
durations=[]
for i in range(gif.n_frames):gif.seek(i);durations.append(gif.info['duration'])
assert durations==[50]*192
gif.seek(0);a=gif.convert('RGB');gif.seek(56);b=gif.convert('RGB')
assert ImageChops.difference(a.crop((46,151,366,471)),b.crop((46,151,366,471))).getbbox()
proof=Image.new('RGB',(1200,1180),BG);proof.paste(a,(0,0));proof.paste(b,(0,590));proof.save(OUT/'gif-decoded-proof.png',optimize=True)
report={'renderer':'PyMuPDF exact surface paths; Pillow same declared radial-gradient stops, transforms, masks and paint order; no browser',
 'editable_svgs_rendered':len(assets),'gif_frames':gif.n_frames,'gif_duration_ms':sum(durations),'gif_size':[1200,590],
 'foreground_hold_pixel_check':'Focused surface interior unchanged across three background-working samples; background pixels changed.',
 'outputs':['focus-preview.png','comparison.png','overview.png','palette-study.png','focus-handoff.gif','handoff-contact-sheet.png','sizes-and-use.png','gif-decoded-proof.png'],
 'scope':'Non-browser shared-geometry renders and decoded GIF checks. Native browser controls/layout/gradients/clipping/playback/accessibility remain unverified.'}
(ROOT/'render-validation.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
