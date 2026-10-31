"""SVG rasterization with equivalent Pillow clipping for PyMuPDF's SVG clip limitation.

The source remains standard editable SVG. The body, vector light layers and exact
compound-contour mask are separately rasterized, then alpha-composited without a browser.
"""
from io import BytesIO
import copy
import xml.etree.ElementTree as ET
import fitz
from PIL import Image, ImageChops

NS = '{http://www.w3.org/2000/svg}'
ET.register_namespace('', 'http://www.w3.org/2000/svg')

def native(svg, size):
    with fitz.open(stream=svg.encode(), filetype='svg') as source:
        with fitz.open('pdf', source.convert_to_pdf()) as pdf:
            page = pdf[0]
            pix = page.get_pixmap(matrix=fitz.Matrix(size/page.rect.width, size/page.rect.height), alpha=True)
            return Image.open(BytesIO(pix.tobytes('png'))).convert('RGBA')

def wrap(node):
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">'+ET.tostring(node, encoding='unicode')+'</svg>'

def raster(svg, size):
    root = ET.fromstring(svg)
    overlays = [c for c in root if c.get('data-overlay')]
    for overlay in overlays:
        root.remove(overlay)
    field = next((c for c in root if c.get('data-field')), None)
    if field is None:
        return native(svg, size)
    lighting = next((c for c in field if c.get('clip-path')), None)
    if lighting is None:
        return native(svg, size)
    opacity = float(field.get('opacity','1'))
    field.remove(lighting)
    field.set('opacity','1')
    body = native(wrap(field), size)
    contour = next(c for c in field if c.get('data-contour'))
    masknode = copy.deepcopy(contour)
    masknode.set('fill', '#FFFFFF')
    mask = native(wrap(masknode), size).getchannel('A')
    light = native(wrap(lighting[0]), size)
    light.putalpha(ImageChops.multiply(light.getchannel('A'), mask))
    body = Image.alpha_composite(body, light)
    if opacity != 1:
        body.putalpha(body.getchannel('A').point(lambda a: round(a*opacity)))
    root.remove(field)
    back = native(ET.tostring(root, encoding='unicode'), size)
    result = Image.alpha_composite(back, body)
    for overlay in overlays:
        result = Image.alpha_composite(result, native(wrap(overlay), size))
    return result
