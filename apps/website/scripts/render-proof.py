"""Pillow layout proofs of the real Next-rendered first scene. Not screenshots.

Reuses the previous study's browser-independent canvas/fonts, reads copy from the
actual production SSR output, and writes only this app's preview folder.
"""
from pathlib import Path
from html.parser import HTMLParser
import importlib.util
import json
import sys
from subprocess import run

sys.dont_write_bytecode = True
APP = Path(__file__).resolve().parents[1]
REPO = APP.parents[1]
shared = REPO / 'design/muse-logo/v3/musefocus-site/source/render_preview.py'
spec = importlib.util.spec_from_file_location('focus_proof_canvas', shared)
canvas = importlib.util.module_from_spec(spec)
spec.loader.exec_module(canvas)
C = canvas.Canvas


class Copy(HTMLParser):
    def __init__(self):
        super().__init__(); self.stack=[]; self.nodes=[]
    def handle_starttag(self,tag,attrs):
        if tag in ['img','meta','link','input','path','use','br']:return
        item={'tag':tag,'attrs':dict(attrs),'text':''};self.nodes.append(item);self.stack.append(item)
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i]['tag']==tag:self.stack=self.stack[:i];break
    def handle_data(self,data):
        for item in self.stack:item['text']+=data
    def cls(self,name):
        return [' '.join(n['text'].split()) for n in self.nodes if name in n['attrs'].get('class','').split()]


copy=Copy();copy.feed((APP/'.next/server/app/index.html').read_text())
WHITE='#f5f5f7';ICE='#c3e2ff';SECONDARY='#a1a1ad'


def hero(c,mobile):
    w=c.w;x=20 if mobile else 40;center=w/2
    c.logo(x-3,17 if mobile else 20,30);c.text(x+34,20 if mobile else 23,'MuseFocus',16 if mobile else 18,WHITE,'bold')
    if not mobile:
        c.text(w-460,29,'Your day, in focus',13,SECONDARY);c.text(w-288,29,'Questions',13,SECONDARY)
    bw=127 if mobile else 158;c.rect((w-x-bw,17,w-x,51),'#15161c',20,'#22232a');c.text(w-x-bw+14,26,'Find your focus  ↗',11 if mobile else 12,WHITE)
    y=109 if mobile else 128;size=96 if mobile else 120;c.logo(center-size/2,y,size);y+=size+22
    c.text(center,y,'YOUR ATTENTION, WELL SPENT',8 if mobile else 10,'#a0bad8','mono','ma');y+=38
    fs=44 if mobile else 80;lead=47 if mobile else 85
    c.text(center,y,'Let work flow.',fs,WHITE,'bold','ma');y+=lead
    c.text(center,y,'Keep your focus.',fs,ICE,'bold','ma');y+=lead+21
    pw=w-40 if mobile else 580
    y=c.paragraph(center-pw/2,y,copy.cls('hero-copy')[0],pw,15 if mobile else 18,leading=27 if mobile else 30,center=True);y+=25
    if mobile:
        c.button(center-137,y,'Explore a day with MuseFocus',274,45,12);y+=64;c.text(center,y,'Why focus?  ↘',11,SECONDARY,anchor='ma');y+=35
    else:
        c.button(center-210,y,'Explore a day with MuseFocus',277,46,13);c.text(center+94,y+14,'Why focus?  ↘',13,SECONDARY);y+=66
    c.text(center,y,'•  Built for macOS  ·  In development',9 if mobile else 11,'#747481',anchor='ma')
    return y+(50 if mobile else 65)


def demo(c,y,mobile):
    x=20 if mobile else (c.w-1160)/2;w=c.w-2*x
    c.text(x,y,'ONE CONNECTED DAY',7 if mobile else 8,'#7c98bf','mono');y+=18
    c.text(x,y,'Everything moves.' if mobile else copy.cls('demo-intro')[0].removeprefix('One connected day').split('Pause motion')[0].strip(),13 if mobile else 17,'#c9d3e4')
    c.text(x+w,y+2,'Pause motion',7 if mobile else 10,'#747481',anchor='ra');y+=37
    labels=['Plan your day','Review in context','Zoom out','Propose a fix','Leave instructions','Keep your focus']
    gap=6 if mobile else 5;columns=3 if mobile else 6;tw=(w-gap*(columns-1))/columns;th=38 if mobile else 42
    for i,label in enumerate(labels):
        tx=x+(i%columns)*(tw+gap);ty=y+(i//columns)*(th+6)
        c.rect((tx,ty,tx+tw,ty+th),'#1a2a41' if i==0 else '#0a0d13',7,'#36557d' if i==0 else '#171e29')
        c.text(tx+9,ty+13,str(i+1).zfill(2),7 if mobile else 8,'#a3caff' if i==0 else '#56657b','mono')
        c.text(tx+29,ty+12,label,7 if mobile else 10,'#d8eaff' if i==0 else '#7f8ba0')
    y+=(th+6)*(2 if mobile else 1)+14
    top=y;side=0 if mobile else 218;bodyh=805 if mobile else 670;bar=36 if mobile else 40
    c.rect((x,y,x+w,y+bodyh),'#0d0e12',13,'#2b2c34')
    c.rect((x+1,y+1,x+w-1,y+bar),'#14151a',12);c.rect((x+1,y+15,x+w-1,y+bar),'#14151a')
    for i,color in enumerate(['#ff5f57','#febc2e','#28c840']):c.rect((x+13+i*(12 if mobile else 16),y+14,x+20+i*(12 if mobile else 16),y+21),color,5)
    c.text(c.w/2,y+12,'MuseFocus',10 if mobile else 11,'#a0a4b0',anchor='ma');c.text(x+w-13,y+14,'Interactive illustration',6 if mobile else 8,'#858f9f','mono','ra')
    y+=bar;c.line([(x,y),(x+w,y)])
    if not mobile:
        c.rect((x+1,y,x+side,y+bodyh-bar-1),'#111216');c.line([(x+side,y),(x+side,top+bodyh)])
        c.logo(x+17,y+24,26);c.text(x+52,y+31,'MuseFocus',13,'#c1d9fa','bold');c.text(x+21,y+91,'YOUR WORK, CONNECTED',8,'#77869d','mono')
        for i,(title,status,key) in enumerate([('Session recovery','A question before we start','i-code'),('Review progress','Teammate’s PR · Ready for review','i-layers'),('Website won’t load','Missing a little context','i-chat')]):
            ty=y+132+i*75;c.icon(x+22,ty+1,key,15,'#7589a6');c.text(x+49,ty,title,10,'#c2ccdc');c.text(x+49,ty+21,status,8,'#7485a0')
        for i,h in enumerate([8,16,21,16,8]):c.rect((x+24+i*4,top+bodyh-49-h/2,x+26+i*4,top+bodyh-49+h/2),'#72a0e0',1)
        c.text(x+52,top+bodyh-60,'Work keeps moving.',9,'#96a2b6');c.text(x+52,top+bodyh-42,'You set the pace.',9,'#64738c')
    fx=x+side;fw=w-side;c.text(fx+20 if mobile else fx+29,y+14,'•  In focus   /   Linear',9 if mobile else 10,'#a8b4c7');c.text(x+w-22,y+14,'01 / 06',8 if mobile else 9,'#76859b','mono','ra')
    y+=38 if mobile else 44;c.line([(fx,y),(x+w,y)])
    inset=16 if mobile else 33;lx=fx+inset;lw=fw-inset*2;y+=25 if mobile else 30
    c.text(lx,y,copy.cls('scene-eyebrow')[0],9 if mobile else 10,'#9dbce6');y+=30
    fs=24 if mobile else 29
    y=c.paragraph(lx,y,'Start with the right questions.',lw,fs,WHITE,fs*1.2,'bold');y+=16
    y=c.paragraph(lx,y,copy.cls('scene-description')[0],min(590,lw),10 if mobile else 12,'#93a0b6',18 if mobile else 21.6);y+=24
    c.icon(lx,y,'i-layers',13,'#a0b6d7');c.text(lx+20,y,'ENG-142 · Session recovery',8 if mobile else 9,'#a0b6d7','mono');y+=36
    c.text(lx,y,'The ticket',9,'#869ab8','mono');y+=23
    y=c.paragraph(lx,y,'“Let me reopen a workspace and pick up where I left off.”',lw,14 if mobile else 15,'#c5d8f1',24 if mobile else 25.5);y+=22
    boxy=y;boxh=234 if mobile else 183;c.rect((lx,y,lx+lw,y+boxh),'#111925',8,'#29415f')
    c.logo(lx+13,y+13,24);c.text(lx+45,y+19,'One decision before the first pass.',9 if mobile else 10,'#a9c7ed');y+=58
    y=c.paragraph(lx+14,y,'What should come back when you reopen it?',lw-28,11 if mobile else 12,'#d0e0f5',19);y+=15
    for i,(label,note) in enumerate([('Files + review position','Start with the place I was reviewing.'),('The working layout, too','Keep my open panes and their arrangement.')]):
        cw=lw-28 if mobile else (lw-38)/2;cx=lx+14 if mobile else lx+14+i*(cw+10);cy=y+i*67 if mobile else y
        c.rect((cx,cy,cx+cw,cy+57),'#0c111a',6,'#27354a');c.rect((cx+11,cy+15,cx+21,cy+25),'#0c111a',5,'#627694')
        c.text(cx+30,cy+11,label,10,'#c4d6ef');c.paragraph(cx+30,cy+31,note,cw-40,8 if mobile else 9,'#7186a5',14)
    y=boxy+boxh+19;c.icon(lx,y,'i-spark',14,'#6884a9');c.text(lx+24,y,'Your judgment sets the direction',10,'#9cafc9');y+=24
    y=c.paragraph(lx+24,y,'Choose an answer to see how a useful implementation brief takes shape.',lw-24,9,'#6f819c',16)
    bottom=max(top+bodyh,y+90);footer=bottom-64;c.line([(fx,footer),(x+w,footer)])
    c.text(lx,footer+25,'Your attention stays here.',7 if mobile else 9,'#7187a6');bw=137 if mobile else 159;c.button(x+w-inset-bw,footer+14,'Next into focus',bw,36,8 if mobile else 10)
    # Native-size bounds are content-fitted, as the CSS frame is in the real app.
    if bottom>top+bodyh:
        c.line([(x,bottom),(x+w,bottom)],'#2b2c34')
    y=c.paragraph(x,bottom+22,copy.cls('demo-caption')[0],w,9 if mobile else 10,'#6e7b91',16,center=True)
    return y+50


def main():
    out=APP/'preview';out.mkdir(exist_ok=True)
    sizes={}
    for width,mobile,name in [(1440,False,'desktop'),(390,True,'mobile')]:
        c=C(width,2300);c.glow(width/2,280,450,295,.14)
        y=hero(c,mobile);bottom=demo(c,y,mobile)
        c.text(width/2,bottom+12,'LAYOUT PROOF · REACT SERVER COPY · NOT A BROWSER SCREENSHOT',6 if mobile else 9,'#52627a','mono','ma')
        c.h=round(bottom+50);c.im=c.im.crop((0,0,width*canvas.SCALE,c.h*canvas.SCALE));c.save(out/f'{name}.png');sizes[name]=[width,c.h]
    (out/'scope.json').write_text(json.dumps({'source':'.next/server/app/index.html','renderer':'Pillow/PyMuPDF, shared prior study canvas and exact brand art/fonts','isBrowserScreenshot':False,'browserChecks':False,'layouts':sizes},indent=2)+'\n')
    run(['bunx', '--no-install', 'biome', 'format', '--write', str(out/'scope.json')], cwd=REPO, check=True, capture_output=True)
    print(json.dumps(sizes))


if __name__=='__main__':main()
