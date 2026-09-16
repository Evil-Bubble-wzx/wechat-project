from PIL import Image, ImageDraw, ImageFont
from pathlib import Path
import math, random
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT/'assets'
(OUT/'covers').mkdir(parents=True, exist_ok=True)
(OUT/'icons').mkdir(parents=True, exist_ok=True)
S=2
def font(n, bold=False, serif=False):
    name = 'georgiab.ttf' if serif else ('arialbd.ttf' if bold else 'arial.ttf')
    return ImageFont.truetype('C:/Windows/Fonts/'+name, n)
def leaf(d,x,y,size,color):
    d.ellipse((x-size,y-size/3,x+size,y+size/3), fill=color)
def sprout(d,x,y,k=1,color='#657B4A'):
    d.line((x,y,x,y-55*k),fill=color,width=max(2,int(4*k)))
    d.ellipse((x-32*k,y-55*k,x,y-35*k),fill=color)
    d.ellipse((x,y-70*k,x+32*k,y-47*k),fill=color)
def rabbit(d,x,y,k=1):
    def box(a,b,c,e): return (x+a*k,y+b*k,x+c*k,y+e*k)
    d.ellipse(box(-58,28,65,160),fill='#F7F2E2')
    d.ellipse(box(-40,-76,-11,14),fill='#F8F4E8')
    d.ellipse(box(2,-92,30,10),fill='#F8F4E8')
    d.ellipse(box(-32,-62,-19,-1),fill='#E0B9A6')
    d.ellipse(box(9,-77,22,-6),fill='#E0B9A6')
    d.ellipse(box(-60,-9,54,86),fill='#F8F4E8')
    d.ellipse(box(16,26,23,34),fill='#394738')
    d.ellipse(box(43,47,51,53),fill='#BD8D78')
    d.ellipse(box(14,44,36,57),fill='#E8C3A7')
    d.ellipse(box(-74,99,-27,143),fill='#FFFBF0')
    d.ellipse(box(-37,139,2,163),fill='#F8F4E8')
    d.ellipse(box(15,139,63,163),fill='#F8F4E8')
    d.polygon([(x-29*k,y+68*k),(x+40*k,y+68*k),(x+57*k,y+114*k),(x-42*k,y+114*k)],fill='#B3BE81')
def fox(d,x,y,k=1):
    d.ellipse((x-30*k,y+40*k,x+80*k,y+159*k),fill='#C97840')
    d.polygon([(x-20*k,y+123*k),(x-97*k,y+77*k),(x-125*k,y+120*k),(x-64*k,y+163*k),(x+20*k,y+159*k)],fill='#C97840')
    d.polygon([(x-97*k,y+77*k),(x-125*k,y+120*k),(x-86*k,y+139*k)],fill='#F6E7C8')
    d.polygon([(x-46*k,y+42*k),(x-54*k,y-45*k),(x-4*k,y-9*k),(x+39*k,y-41*k),(x+61*k,y+48*k),(x+10*k,y+90*k)],fill='#D98C50')
    d.polygon([(x-44*k,y+34*k),(x+8*k,y+55*k),(x+55*k,y+31*k),(x+10*k,y+90*k)],fill='#F8EAD0')
    d.ellipse((x-18*k,y+26*k,x-12*k,y+34*k),fill='#3D4035')
    d.ellipse((x+26*k,y+26*k,x+32*k,y+34*k),fill='#3D4035')
    d.ellipse((x+4*k,y+57*k,x+14*k,y+65*k),fill='#3D4035')
def bear(d,x,y,k=1):
    d.ellipse((x-57*k,y-31*k,x-10*k,y+18*k),fill='#997453')
    d.ellipse((x+30*k,y-31*k,x+77*k,y+18*k),fill='#997453')
    d.ellipse((x-72*k,y+49*k,x+88*k,y+196*k),fill='#A27C58')
    d.ellipse((x-56*k,y-16*k,x+75*k,y+99*k),fill='#AF8861')
    d.ellipse((x-14*k,y+33*k,x+43*k,y+77*k),fill='#D9B993')
    d.ellipse((x-23*k,y+26*k,x-16*k,y+35*k),fill='#384333')
    d.ellipse((x+36*k,y+26*k,x+43*k,y+35*k),fill='#384333')
    d.ellipse((x+8*k,y+40*k,x+23*k,y+51*k),fill='#384333')
    d.rectangle((x-54*k,y+89*k,x+70*k,y+135*k),fill='#73885D')
def star(d,x,y,r,c):
    pts=[(x+math.sin(i*math.pi/5)*(r if i%2==0 else r*.43),y-math.cos(i*math.pi/5)*(r if i%2==0 else r*.43)) for i in range(10)]
    d.polygon(pts,fill=c)
def centered(d,text,y,n,c,serif=False):
    f=font(n,True,serif); w=d.textbbox((0,0),text,font=f)[2];d.text(((480-w)/2,y),text,font=f,fill=c)
for key,bg in [('little-seed','#DEE6BB'),('fox-star','#293E51'),('bear-picnic','#EDDBC0')]:
    im=Image.new('RGB',(480,600),bg); d=ImageDraw.Draw(im)
    d.rounded_rectangle((20,20,460,580),radius=6,outline='#BFC99D' if key=='little-seed' else ('#667583' if key=='fox-star' else '#D4BB94'),width=2)
    ink='#3F5B3E' if key=='little-seed' else ('#F7EBD3' if key=='fox-star' else '#685038')
    centered(d,'YAYA  LITTLE  LIBRARY',49,14,ink)
    if key=='little-seed':
        centered(d,'The Little',95,43,ink,True); centered(d,'Seed',144,55,ink,True)
        d.ellipse((-70,400,620,810),fill='#B9C893')
        d.ellipse((25,295,149,419),fill='#F7E5A7')
        for x,y in [(63,487),(401,426),(425,518)]: sprout(d,x,y,.65)
        rabbit(d,228,350,1.05); sprout(d,344,479,.95)
        d.ellipse((278,485,404,511),fill='#A9B37F')
        sprout(d,340,492,.65)
    elif key=='fox-star':
        centered(d,'Fox and',95,45,ink,True); centered(d,'the Star',150,45,ink,True)
        d.ellipse((-60,455,650,940),fill='#354E51')
        for x,y in [(76,252),(378,324),(415,219),(150,298),(69,374)]: star(d,x,y,5,'#D9C79D')
        star(d,322,281,26,'#F8DEA2');d.line((322,309,302,360),fill='#758075',width=2)
        for x,y,k in [(55,442,.8),(414,431,1)]: sprout(d,x,y,k,'#758A70')
        fox(d,256,374,.95)
    else:
        centered(d,"Bear's",95,49,ink,True);centered(d,'Picnic',151,49,ink,True)
        d.ellipse((-100,400,600,850),fill='#C1C79A')
        d.polygon([(71,486),(343,464),(416,551),(121,568)],fill='#F4EEE0')
        for i in range(4): d.line((90+i*70,482,138+i*70,562), fill='#D59C7B',width=9)
        bear(d,249,327,.95)
        d.rounded_rectangle((78,428,181,502),radius=14,fill='#C18B53')
        d.arc((92,395,168,464),180,360,fill='#9D713E',width=8)
        d.ellipse((100,416,132,448),fill='#BE6550');sprout(d,407,445,.6)
    centered(d,'A SMALL STORY. A BIG WORLD.',550,13,ink)
    im.resize((384,480),Image.Resampling.LANCZOS).save(OUT/'covers'/f'{key}.png',optimize=True)
# Home hero: generous open space at left for actual UI copy.
im=Image.new('RGB',(1000,520),'#E9EDDA');d=ImageDraw.Draw(im)
d.ellipse((550,-150,1110,430),fill='#DFE5C9')
d.ellipse((460,340,1170,900),fill='#D0DCB5')
d.ellipse((743,60,850,167),fill='#F3D996')
d.arc((612,50,870,330),190,273,fill='#C2CEA8',width=3)
rabbit(d,747,225,1.12)
d.polygon([(669,359),(732,342),(778,365),(829,344),(844,400),(785,419),(720,399)],fill='#FBF7E9')
d.line((778,365,785,419),fill='#C4BA9B',width=3)
sprout(d,926,440,1.1);sprout(d,577,440,.7)
for x,y in [(626,159),(911,242)]:star(d,x,y,10,'#C1AA61')
im.save(OUT/'hero.png',optimize=True)
im=Image.new('RGBA',(220,220),'#E9EDDA');d=ImageDraw.Draw(im);rabbit(d,113,93,.60);im.save(OUT/'avatar.png',optimize=True)
# Crisp line icons.
for name in ['discover','book','person','headphones','quiz','leaf','search','play','pause','lock','check','heart','clock','back','next','replay','star','volume']:
  for variant,col in [('on','#397357'),('off','#939B91'),('white','#FFFFFF')]:
    im=Image.new('RGBA',(96,96));d=ImageDraw.Draw(im); w=6
    if name=='discover':
      d.ellipse((15,15,81,81),outline=col,width=w);d.polygon([(58,31),(53,55),(31,65),(40,42)],fill=col)
    elif name=='book':
      d.line([(48,26),(33,20),(15,22),(15,72),(32,70),(48,77),(64,70),(81,72),(81,22),(64,20),(48,26),(48,77)],fill=col,width=w,joint='curve')
    elif name=='person':
      d.ellipse((34,13,62,41),outline=col,width=w);d.arc((20,48,76,101),180,360,fill=col,width=w);d.line((20,75,76,75),fill=col,width=w)
    elif name=='headphones':
      d.arc((17,14,79,78),180,360,fill=col,width=w);d.rounded_rectangle((15,45,30,77),radius=5,outline=col,width=w);d.rounded_rectangle((66,45,81,77),radius=5,outline=col,width=w)
    elif name=='quiz':
      d.rounded_rectangle((23,15,73,81),radius=7,outline=col,width=w);d.line((35,37,61,37),fill=col,width=4);d.line((35,50,60,50),fill=col,width=4);d.line((35,63,52,63),fill=col,width=4)
    elif name=='leaf':
      d.arc((15,19,79,79),0,300,fill=col,width=w);d.line((25,77,70,27),fill=col,width=w);d.line((70,27,74,65),fill=col,width=w)
    elif name=='search':
      d.ellipse((19,15,66,62),outline=col,width=w);d.line((60,58,80,79),fill=col,width=w)
    elif name=='play': d.polygon([(34,20),(76,48),(34,77)],fill=col)
    elif name=='pause':d.rounded_rectangle((28,23,40,75),radius=4,fill=col);d.rounded_rectangle((56,23,68,75),radius=4,fill=col)
    elif name=='lock':
      d.arc((30,12,66,59),180,360,fill=col,width=w);d.rounded_rectangle((21,40,75,80),radius=7,outline=col,width=w);d.ellipse((44,54,52,62),fill=col)
    elif name=='check': d.line([(20,49),(40,68),(77,28)],fill=col,width=w,joint='curve')
    elif name=='heart':
      d.line([(48,77),(17,44),(18,27),(31,20),(48,32),(65,20),(78,27),(79,44),(48,77)],fill=col,width=w,joint='curve')
    elif name=='clock':
      d.ellipse((14,14,82,82),outline=col,width=w);d.line([(48,28),(48,48),(64,57)],fill=col,width=w)
    elif name in ['back','next']:
      pts=[(63,20),(32,48),(63,76)] if name=='back' else [(33,20),(64,48),(33,76)]
      d.line(pts,fill=col,width=w,joint='curve')
    elif name=='replay':
      d.arc((18,19,79,80),-65,230,fill=col,width=w);d.line([(17,21),(17,43),(40,43)],fill=col,width=w)
    elif name=='star':star(d,48,48,35,col)
    elif name=='volume':
      d.polygon([(16,38),(32,38),(51,21),(51,75),(32,58),(16,58)],fill=col);d.arc((34,26,78,71),-60,60,fill=col,width=w)
    im.resize((64,64),Image.Resampling.LANCZOS).save(OUT/'icons'/f'{name}-{variant}.png',optimize=True)
print('Created illustrated covers, hero, avatar and icons.')
