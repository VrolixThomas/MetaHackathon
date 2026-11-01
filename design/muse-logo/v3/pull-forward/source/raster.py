"""Equivalent non-browser rendering for SVG surfaces, masks and radial light.

PyMuPDF renders exact paths; Pillow paints the same declared radial-gradient stops
and applies the exact vector mask. Masters remain ordinary editable SVG.
"""
from io import BytesIO
import copy
import math
import re
import xml.etree.ElementTree as ET
import fitz
from PIL import Image,ImageChops
NS='{http://www.w3.org/2000/svg}'
ET.register_namespace('','http://www.w3.org/2000/svg')

def native(svg,size):
    with fitz.open(stream=svg.encode(),filetype='svg') as source:
        with fitz.open('pdf',source.convert_to_pdf()) as pdf:
            p=pdf[0];pix=p.get_pixmap(matrix=fitz.Matrix(size/p.rect.width,size/p.rect.height),alpha=True)
            return Image.open(BytesIO(pix.tobytes('png'))).convert('RGBA')

def wrap(node):return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">'+ET.tostring(node,encoding='unicode')+'</svg>'

def transform(value):
    t=re.search(r'translate\(([-.0-9]+) ([-.0-9]+)\)',value)
    s=re.search(r'scale\(([-.0-9]+)\)',value)
    return (float(t[1]),float(t[2]),float(s[1])) if t and s else (0,0,1)

def light(node,size,tr=(0,0,1)):
    tx,ty,scale=tr;k=size/256
    x=(float(node.get('data-x'))*scale+tx)*k
    y=(float(node.get('data-y'))*scale+ty)*k
    r=float(node.get('data-r'))*scale*k
    stops=[(float(s.get('offset')),float(s.get('stop-opacity'))) for s in node.iter(NS+'stop')]
    lut=[]
    for value in range(256):
        # Pillow normalizes distance to a corner; SVG normalizes to the circle edge.
        t=min(1,value/255*math.sqrt(2))
        i=min(15,int(t*16));a,b=stops[i],stops[i+1]
        v=a[1]+(b[1]-a[1])*(t-a[0])/(b[0]-a[0]);lut.append(round(v*255))
    diameter=max(2,math.ceil(r*2))
    alpha=Image.radial_gradient('L').resize((diameter,diameter),Image.Resampling.BICUBIC).point(lut)
    patch=Image.new('RGBA',(diameter,diameter),node.get('data-color'));patch.putalpha(alpha)
    result=Image.new('RGBA',(size,size));result.alpha_composite(patch,(round(x-r),round(y-r)))
    return result

def raster(svg,size):
    root=ET.fromstring(svg)
    layers=[c for c in root if c.get('data-layer')]
    glows=[c for c in root if c.get('data-glow')]
    if not layers:return native(svg,size)
    for c in layers+glows:root.remove(c)
    out=native(ET.tostring(root,encoding='unicode'),size)
    for c in glows:out=Image.alpha_composite(out,light(c,size))
    for layer in layers:
        illumination=next((c for c in layer if c.get('data-lighting')),None)
        if illumination is None:out=Image.alpha_composite(out,native(wrap(layer),size));continue
        layer.remove(illumination)
        edge=[c for c in layer if c.tag==NS+'path' and c.get('stroke')]
        for c in edge:layer.remove(c)
        body=native(wrap(layer),size)
        masknode=copy.deepcopy(layer)
        for c in list(masknode):
            if not c.get('data-surface'):masknode.remove(c)
            else:c.set('fill','#FFFFFF')
        mask=native(wrap(masknode),size).getchannel('A')
        tr=transform(layer.get('transform',''))
        lit=Image.new('RGBA',(size,size))
        for c in illumination:
            if c.get('data-glow'):lit=Image.alpha_composite(lit,light(c,size,tr))
        lit.putalpha(ImageChops.multiply(lit.getchannel('A'),mask));body=Image.alpha_composite(body,lit)
        if edge:
            e=ET.Element(NS+'g',{'transform':layer.get('transform','')})
            for c in edge:e.append(c)
            body=Image.alpha_composite(body,native(wrap(e),size))
        out=Image.alpha_composite(out,body)
    return out
