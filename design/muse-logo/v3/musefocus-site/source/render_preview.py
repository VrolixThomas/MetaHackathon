"""Non-browser layout proofs using the site's copy, font files and real brand PNG.

Pillow composes the documented CSS layout. These are design proofs, NOT browser
screenshots or evidence of CSS layout/animation execution.
"""
from pathlib import Path
from html.parser import HTMLParser
import json
import math
import re
from io import BytesIO
import fitz
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'
SCALE = 2
FONTS = ROOT / 'source/fonts'
BASE = '#050507'
WHITE = '#f5f5f7'
SECONDARY = '#a1a1ad'
ICE = '#c3e2ff'
BLUE = '#78aefa'


class Copy(HTMLParser):
    def __init__(self):
        super().__init__(); self.stack = []; self.values = {}
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'br':
            for _, key in self.stack:
                if key: self.values[key] += '\n'
        elif tag not in ('img', 'meta', 'link', 'use', 'input'):
            key = attrs.get('id'); self.stack.append((tag, key))
            if key: self.values[key] = ''
    def handle_endtag(self, tag):
        for i in range(len(self.stack)-1, -1, -1):
            if self.stack[i][0] == tag:
                self.stack = self.stack[:i]; break
    def handle_data(self, data):
        for _, key in self.stack:
            if key: self.values[key] += data


COPY = Copy(); COPY.feed((DIST / 'index.html').read_text())
TEXT = {k: v.strip() for k, v in COPY.values.items()}
MARK = Image.open(DIST / 'assets/pull-forward.png').convert('RGBA')


class Canvas:
    def __init__(self, width, height):
        self.w = width; self.h = height
        self.im = Image.new('RGB', (width*SCALE, height*SCALE), BASE)
        self.d = ImageDraw.Draw(self.im)
    def font(self, size, weight='regular'):
        name = {'regular':'Geist-Regular.ttf', 'bold':'Geist-SemiBold.ttf', 'mono':'GeistMono-Regular.ttf'}[weight]
        return ImageFont.truetype(str(FONTS/name), round(size*SCALE))
    def rect(self, box, fill, radius=0, outline=None):
        box = tuple(round(x*SCALE) for x in box)
        self.d.rounded_rectangle(box, radius=round(radius*SCALE), fill=fill, outline=outline, width=SCALE)
    def line(self, points, fill='#20232b', width=1):
        self.d.line([(round(x*SCALE),round(y*SCALE)) for x,y in points], fill=fill, width=max(1,round(width*SCALE)))
    def text(self, x, y, value, size, color=WHITE, weight='regular', anchor='la'):
        self.d.text((x*SCALE,y*SCALE), value, font=self.font(size,weight), fill=color, anchor=anchor, spacing=0)
    def length(self, value, size, weight='regular'):
        return self.d.textlength(value, font=self.font(size,weight))/SCALE
    def wrap(self, value, width, size, weight='regular'):
        lines = []
        for paragraph in value.split('\n'):
            words = paragraph.split(); line = ''
            for word in words:
                trial = (line+' '+word).strip()
                if line and self.length(trial,size,weight)>width: lines.append(line); line=word
                else: line=trial
            lines.append(line)
        return lines
    def paragraph(self,x,y,value,width,size,color=SECONDARY,leading=None,weight='regular',center=False):
        leading=leading or size*1.8
        for line in self.wrap(value,width,size,weight):
            self.text(x+width/2 if center else x,y,line,size,color,weight,'ma' if center else 'la');y+=leading
        return y
    def logo(self,x,y,size):
        p=MARK.resize((round(size*SCALE),round(size*SCALE)),Image.Resampling.LANCZOS)
        self.im.paste(p,(round(x*SCALE),round(y*SCALE)),p)
    def glow(self,cx,cy,rx,ry,opacity=.12):
        size=(round(rx*2*SCALE),round(ry*2*SCALE))
        alpha=Image.radial_gradient('L').resize(size).point(lambda x:round(max(0,1-x/255*math.sqrt(2))**2*opacity*255))
        patch=Image.new('RGBA',size,(70,115,208));patch.putalpha(alpha)
        self.im.paste(patch,(round((cx-rx)*SCALE),round((cy-ry)*SCALE)),patch)
        self.d=ImageDraw.Draw(self.im)
    def icon(self,x,y,key,size=16,color='#a8d2ff'):
        source=(DIST/'index.html').read_text()
        body=re.search(r'<symbol id="'+re.escape(key)+r'"[^>]*>(.*?)</symbol>',source).group(1)
        svg=f'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="{color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">{body}</g></svg>'
        with fitz.open(stream=svg.encode(),filetype='svg') as src:
            with fitz.open('pdf',src.convert_to_pdf()) as pdf:
                pix=pdf[0].get_pixmap(matrix=fitz.Matrix(size*SCALE/24,size*SCALE/24),alpha=True)
                im=Image.open(BytesIO(pix.tobytes('png'))).convert('RGBA')
        self.im.paste(im,(round(x*SCALE),round(y*SCALE)),im)
    def button(self,x,y,label,width=None,height=46,size=13,primary=True):
        width=width or self.length(label,size,'bold')+61
        self.rect((x,y,x+width,y+height),'#bddbff' if primary else '#161b25',height/2,'#d4e9ff' if primary else '#2b3443')
        self.text(x+19,y+(height-size)/2-2,label,size,'#102039' if primary else ICE,'bold')
        self.text(x+width-26,y+(height-18)/2-3,'→',18,'#102039' if primary else ICE)
        return width
    def save(self,path):
        self.im.resize((self.w,self.h),Image.Resampling.LANCZOS).save(path,optimize=True)


def navbar(c,mobile=False):
    x=20 if mobile else 40
    c.logo(x-3,17 if mobile else 20,30)
    c.text(x+34,20 if mobile else 23,'MuseFocus',16 if mobile else 18,WHITE,'bold')
    if not mobile:
        c.text(c.w-416,29,'The workflow',13,SECONDARY)
        c.text(c.w-288,29,'Questions',13,SECONDARY)
    w=127 if mobile else 158
    c.rect((c.w-x-w,17,c.w-x,51),'#15161c',20,'#22232a')
    c.text(c.w-x-w+14,26,'Find your focus  ↗',11 if mobile else 12,WHITE)


def hero(c,mobile=False):
    center=c.w/2
    y=109 if mobile else 128
    size=96 if mobile else 120;c.logo(center-size/2,y,size);y+=size+22
    c.text(center,y,'YOUR ATTENTION, WELL SPENT',8 if mobile else 10,'#a0bad8','mono','ma');y+=38
    fs=44 if mobile else 80;lead=47 if mobile else 85
    c.text(center,y,'Let work flow.',fs,WHITE,'bold','ma');y+=lead
    c.text(center,y,'Keep your focus.',fs,ICE,'bold','ma');y+=lead+21
    y=c.paragraph(20 if mobile else center-277.5,y,'MuseFocus moves work forward in the background, then brings one thing into focus to review, discuss, and decide.',c.w-40 if mobile else 555,15 if mobile else 18,leading=27 if mobile else 30,center=True)
    y+=25
    if mobile:
        w=186;c.button(center-w/2,y,'See focus in action',w,45,12);y+=64
        c.text(center,y,'Meet your new workflow  ↘',11,SECONDARY,anchor='ma');y+=35
    else:
        c.button(center-220,y,'See focus in action',206,46,13)
        c.text(center+12,y+14,'Meet your new workflow  ↘',13,SECONDARY);y+=66
    c.text(center,y,'•  Built for macOS  ·  In development',9 if mobile else 11,'#747481',anchor='ma')
    return y+(47 if mobile else 62)


def workspace(c,y,mobile=False):
    x=20 if mobile else max(32,(c.w-1140)/2);w=c.w-x*2
    c.text(x+3,y,'A little less switching.' if mobile else 'A little less switching. A lot more focus.',9 if mobile else 12,SECONDARY)
    c.text(x+w,y+2,'Pause ambient motion',7 if mobile else 10,'#747481',anchor='ra');y+=29
    top=y;bar=39;side=0 if mobile else 220
    body_height=710 if mobile else 620
    c.rect((x,y,x+w,y+body_height),'#0d0e12',13,'#2b2c34')
    c.rect((x+1,y+1,x+w-1,y+bar),'#14151a',12)
    c.rect((x+1,y+14,x+w-1,y+bar),'#14151a')
    for i,col in enumerate(['#ff5f57','#febc2e','#28c840']):c.rect((x+15+i*16,y+15,x+24+i*16,y+24),col,5)
    c.text(c.w/2,y+13,'MuseFocus',11,'#b6b7c1',anchor='ma')
    c.text(x+w-15,y+14,'Example workspace',7 if mobile else 9,'#868793','mono','ra')
    c.line([(x,y+bar),(x+w,y+bar)])
    y+=bar
    if not mobile:
        c.rect((x+1,y,x+side,y+body_height-bar-1),'#111216')
        c.line([(x+side,y),(x+side,top+body_height)])
        c.logo(x+17,y+23,26);c.text(x+51,y+31,'Your workspace',11,'#c1c3cd')
        c.text(x+22,y+87,'WORK IN MOTION',8,'#818491')
        c.text(x+side-22,y+87,'03',8,'#6d7281','mono','ra')
        for i,(name,status) in enumerate([('Session recovery','Ready to review'),('Empty states','Work in progress'),('Search filters','A decision for you')]):
            ty=y+114+i*65
            if i==0:
                c.rect((x+12,ty,x+side-12,ty+56),'#19263a',7,'#293e5a')
                c.rect((x,ty+13,x+3,ty+29),'#a8d2ff',1)
            c.icon(x+24,ty+17,['i-code','i-layers','i-chat'][i],15,'#a8d2ff' if i==0 else '#838c9f')
            c.text(x+48,ty+12,name,10,'#e3eeff' if i==0 else '#c3c6d1')
            c.text(x+48,ty+31,'•  '+status,8,'#96adcb' if i==0 else '#7b8191')
        c.text(x+48,top+body_height-64,'Work keeps moving.',9,'#9199a9')
        c.text(x+48,top+body_height-47,'You set the pace.',9,'#626d81')
        for i,h in enumerate([8,16,21,16,8]):c.rect((x+23+i*4,top+body_height-53-h/2,x+25+i*4,top+body_height-53+h/2),'#72a0e0',1)
    else:
        for i,(name,status) in enumerate([('Session recovery','Ready to review'),('Empty states','Work in progress'),('Search filters','A decision for you')]):
            tw=(w-36)/3;tx=x+11+i*(tw+7)
            c.rect((tx,y+11,tx+tw,y+71),'#19263a' if i==0 else '#111216',6,'#293e5a' if i==0 else '#191b22')
            c.text(tx+7,y+25,name,8,'#e3eeff' if i==0 else '#c3c6d1')
            c.text(tx+7,y+43,'• '+status,6,'#96adcb' if i==0 else '#7b8191')
        y+=83
        c.line([(x,y),(x+w,y)])
    fx=x+side;fw=w-side
    c.text(fx+21 if mobile else fx+28,y+14,'•  In focus   /   Review',9 if mobile else 10,'#a8b0bf')
    c.text(x+w-22,y+14,'01 / 03',8 if mobile else 9,'#6e7788','mono','ra')
    barh=37 if mobile else 45;c.line([(fx,y+barh),(x+w,y+barh)])
    inset=17 if mobile else 34;lx=fx+inset;lw=fw-inset*2;y+=barh+26
    c.text(lx,y,TEXT['scene-eyebrow'],8 if mobile else 9,'#9fb9dc');y+=23
    c.text(lx,y,TEXT['scene-title'],24 if mobile else 28,WHITE,'bold');y+=41
    y=c.paragraph(lx,y,TEXT['scene-description'],lw if mobile else min(540,lw),10 if mobile else 11,'#939cab',18 if mobile else 20)
    y+=20
    c.icon(lx,y+1,'i-code',12,'#c4dcfa');c.text(lx+18,y,'The change',10,'#c4dcfa')
    c.icon(lx+110,y+1,'i-chat',12,'#747e90');c.text(lx+128,y,'Discuss it',10,'#747e90');y+=25
    c.line([(lx,y),(lx+lw,y)]);c.line([(lx,y),(lx+88,y)],'#a4c9fb');y+=17
    cp=y;c.rect((lx,y,lx+lw,y+247),'#0d1017',7,'#202630')
    c.rect((lx+1,y+1,lx+lw-1,y+34),'#131720',6)
    c.text(lx+11,y+11,TEXT['scene-file'],8 if mobile else 9,'#a7b7ce','mono')
    c.text(lx+lw-11,y+12,'Illustrative proposal',6 if mobile else 8,'#65738a','mono','ra')
    lines=[(12,' type ReviewSession = {',''),(13,'   repository: string;',''),(14,'-  currentFile?: string;','r'),(14,'+  checkpoint?: {','a'),(15,'+    file: string;','a'),(16,'+    position: number;','a'),(17,'+  };','a'),(18,' };','')]
    fs=8 if mobile else 10;lineh=18 if mobile else 19.5;cy=y+49
    for n,line,kind in lines:
        if kind:c.rect((lx+1,cy-1,lx+lw-1,cy+lineh-1),'#131c2b' if kind=='a' else '#21151c')
        c.text(lx+11,cy,str(n),7 if mobile else 8,'#4b5a71','mono')
        c.text(lx+(34 if mobile else 50),cy,line,fs,'#b1d0fb' if kind=='a' else '#af838e' if kind=='r' else '#9da9be','mono');cy+=lineh
    ny=cp+205
    c.rect((lx+1,ny,lx+lw-1,cp+246),'#10151f',6)
    c.paragraph(lx+12,ny+10,TEXT['scene-note'],lw-24,8 if mobile else 9,'#879bb8',13)
    y=cp+270
    c.icon(lx,y+10,'i-revise',11,'#8e9bb0');c.text(lx+17,y+10,'Explore a revision',8 if mobile else 9,'#8e9bb0')
    bw=127 if mobile else 149;c.button(lx+lw-bw,y,'Next into focus',bw,36,8 if mobile else 10)
    bottom=max(top+body_height,y+75)
    # Keep the canvas proof's outer frame fitted to the same content.
    c.line([(fx,bottom-30),(x+w,bottom-30)])
    c.text(fx+20,bottom-18,'•  Your attention stays here. Background work continues.',7 if mobile else 8,'#647289')
    c.line([(x,bottom),(x+w,bottom)],'#2b2c34')
    caption='Interactive product illustration. Choose an item, explore a discussion, or bring the next item into focus.'
    yy=c.paragraph(x,bottom+20,caption,w,9 if mobile else 10,'#6e7585',16,center=True)
    return yy+85


def background_panel(c,x,y,w):
    c.rect((x,y,x+w,y+295),'#10131a',11,'#242933')
    c.icon(x+18,y+16,'i-layers',13,'#a6b6cb');c.text(x+39,y+17,'In motion',10,'#a6b6cb');c.text(x+w-18,y+18,'Example',8,'#637188','mono','ra')
    c.line([(x,y+46),(x+w,y+46)])
    for i,(a,b,s) in enumerate([('Session recovery','Ready for your review','Ready'),('Empty states','Shaping a first pass','Working'),('Search filters','A tradeoff to discuss','Your call')]):
        yy=y+68+i*68;c.rect((x+18,yy,x+50,yy+32),'#213450' if i==0 else '#171b24',8,'#2b3d56' if i==0 else '#222936')
        c.icon(x+26,yy+8,['i-code','i-layers','i-chat'][i],16,'#b0d5ff');c.text(x+63,yy+1,a,11,'#c5cfde');c.text(x+63,yy+20,b,9,'#77879f')
        c.text(x+w-18,yy+9,s,8,'#a5caff' if i==0 else '#6e819d','mono','ra')
        if i<2:c.line([(x+18,yy+48),(x+w-18,yy+48)])
    c.text(x+19,y+273,'•  A clear place for everything in motion.',9,'#6a7e9b')


def conversation_panel(c,x,y,w):
    c.rect((x,y,x+w,y+323),'#10131a',11,'#242933')
    c.icon(x+18,y+16,'i-chat',13,'#a6b6cb');c.text(x+39,y+17,'A moment of clarity',10,'#a6b6cb');c.text(x+w-18,y+18,'Example',8,'#637188','mono','ra')
    c.line([(x,y+46),(x+w,y+46)])
    c.text(x+27,y+75,'“Walk me through',27,'#d5e7ff');c.text(x+27,y+110,'what changed.”',27,'#d5e7ff')
    c.line([(x+27,y+162),(x+w-27,y+162)],'#26384e')
    c.logo(x+24,y+186,32);c.text(x+68,y+191,'Start with the decision.',12,'#b1c9e8')
    c.paragraph(x+68,y+216,'See the change. Understand the reasoning. Ask the next question.',w-93,11,'#7b8ca5',19)
    for i in range(24):
        h=29 if i%4==0 else 17 if i%3==0 else 11 if i%5==0 else 5
        xx=x+w/2-69+i*6;c.rect((xx,y+285-h/2,xx+2,y+285+h/2),'#6588b9',1)


def lower_page(c,y,mobile=False):
    x=20 if mobile else (c.w-1040)/2;w=c.w-2*x;center=c.w/2
    c.text(center,y,'A CALMER WAY TO MOVE FORWARD',8 if mobile else 10,SECONDARY,'mono','ma');y+=34
    fs=34 if mobile else 48;lead=40 if mobile else 56
    c.text(center,y,'Output is abundant.',fs,WHITE,'bold','ma');y+=lead
    c.text(center,y,'Attention is finite.',fs,'#747d90','bold','ma');y+=lead+20
    tw=min(w-15,570)
    y=c.paragraph(center-tw/2,y,'AI can move faster than you can review. MuseFocus gives that work a rhythm: progress in the background, clarity in the foreground, and room for your judgment.',tw,14 if mobile else 16,leading=25 if mobile else 30,center=True)
    y+=95 if mobile else 140
    half=(w-85)/2
    def copy_block(xx,yy,label,title,body,width):
        c.text(xx,yy,label,8 if mobile else 9,'#7c98bf','mono');yy+=30
        fs=35 if mobile else 42
        yy=c.paragraph(xx,yy,title,width,fs,WHITE,fs*1.13,'bold');yy+=23
        yy=c.paragraph(xx,yy,body,width,14 if mobile else 15,leading=26 if mobile else 28.5)
        return yy
    yy=copy_block(x,y,'01 / KEEP THINGS MOVING',TEXT['background-heading'],'Delegate independent coding work while you stay with the task in front of you. Keep a view of progress, then return when there’s something to review.',w if mobile else half)
    if mobile:
        y=yy+32;background_panel(c,x,y,w);y+=385
    else:
        background_panel(c,x+half+85,y-8,half);y=max(yy,y+295)+150
    if mobile:
        yy=copy_block(x,y,'02 / BRING IT INTO FOCUS',TEXT['conversation-heading'],'Review the change with its context close by. Talk through the reasoning, ask for a revision, or decide what comes next. Voice is there when you want it. Typing is, too.',w)
        y=yy+32;conversation_panel(c,x,y,w);y+=410
    else:
        conversation_panel(c,x,y,half)
        yy=copy_block(x+half+85,y+4,'02 / BRING IT INTO FOCUS',TEXT['conversation-heading'],'Review the change with its context close by. Talk through the reasoning, ask for a revision, or decide what comes next. Voice is there when you want it. Typing is, too.',half)
        y=max(yy,y+323)+140
    c.text(x,y,'03 / STAY CONNECTED TO THE WORK',8 if mobile else 9,'#7c98bf','mono');y+=31
    c.text(x,y,TEXT['context-heading'],35 if mobile else 38,WHITE,'bold');y+=65
    yy=c.paragraph(x,y,'Bring GitHub reviews, assigned Linear work and selected Slack conversations into one place. Spend less attention reconstructing what needs you.',w if mobile else 530,14,leading=26)
    if mobile:
        y=yy+30;c.text(x,y,'GitHub       Linear       Slack',13,'#b4bbca');y+=65
    else:
        c.text(x+w-335,y-25,'GitHub       Linear       Slack',13,'#b4bbca');y=yy+70
    c.line([(x,y),(x+w,y)]);y+=70 if mobile else 100
    c.text(x,y,'A FEW THINGS, IN FOCUS',8 if mobile else 10,SECONDARY,'mono');y+=33
    c.text(x,y,TEXT['questions-heading'],30 if mobile else 32,WHITE,'bold')
    qx=x if mobile else x+416;qw=w if mobile else w-416;qy=y+65 if mobile else y-33
    for question in ['What is MuseFocus?','Does work move on without my review?','Where does background work run?','Can I download it yet?']:
        c.line([(qx,qy),(qx+qw,qy)]);c.text(qx,qy+24,question,11 if mobile else 13,'#cbd0da');c.text(qx+qw-4,qy+20,'+',18,'#6d7b90',anchor='ra');qy+=68
    c.line([(qx,qy),(qx+qw,qy)]);y=qy+100
    size=96 if mobile else 112;c.logo(center-size/2,y,size);y+=size+25
    fs=50 if mobile else 64
    c.text(center,y,'Your attention',fs,WHITE,'bold','ma');y+=fs*1.06
    c.text(center,y,'is the point.',fs,WHITE,'bold','ma');y+=fs*1.06+22
    c.text(center,y,'Give it to the work that needs you.',14 if mobile else 16,SECONDARY,anchor='ma');y+=52
    c.button(center-92,y,'Find your focus',184,46,12);y+=69
    c.text(center,y,'MuseFocus for macOS · In development',10,'#637087',anchor='ma');y+=90
    c.line([(x,y),(x+w,y)]);y+=28;c.logo(x,y-3,28);c.text(x+35,y+2,'MuseFocus',14,WHITE,'bold')
    c.text(x+w,y+4,'Work moves. You focus.',9 if mobile else 11,'#5f6573',anchor='ra')
    return y+65


def main():
    out=ROOT/'preview';out.mkdir(exist_ok=True)
    sizes={}
    for width,mobile,name in [(1440,False,'desktop'),(390,True,'mobile')]:
        c=Canvas(width,6000);c.glow(width/2,280,450,295,.14);navbar(c,mobile);y=hero(c,mobile);y=workspace(c,y,mobile);bottom=lower_page(c,y,mobile)
        c.im=c.im.crop((0,0,width*SCALE,round(bottom*SCALE)));c.h=round(bottom)
        c.save(out/f'{name}-layout.png');sizes[name]=[width,c.h]
        # A readable first-screen proof for immediate review.
        crop_h=1450 if not mobile else 1550
        c.im.crop((0,0,width*SCALE,crop_h*SCALE)).resize((width,crop_h),Image.Resampling.LANCZOS).save(out/f'{name}-first-look.png',optimize=True)
    c=Canvas(1200,630);c.glow(850,310,500,400,.8);c.logo(744,135,335)
    c.logo(67,55,35);c.text(110,62,'MuseFocus',22,WHITE,'bold')
    c.text(75,205,'Let work flow.',64,WHITE,'bold');c.text(75,280,'Keep your focus.',64,ICE,'bold')
    c.text(78,404,'Background work. Foreground clarity.',20,SECONDARY)
    c.text(78,540,'YOUR ATTENTION, WELL SPENT',11,'#8ca7ca','mono')
    c.save(DIST/'assets/musefocus-social.png')
    (out/'render-scope.json').write_text(json.dumps({'renderer':'Pillow layout composition using real site copy, local Geist fonts and Pull forward PNG','isBrowserScreenshot':False,'browserValidationPerformed':False,'layouts':sizes},indent=2)+'\n')
    print(json.dumps(sizes))


if __name__=='__main__':main()
