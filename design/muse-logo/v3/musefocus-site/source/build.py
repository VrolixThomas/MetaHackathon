"""Assemble a single manual-open HTML and check every local reference. No server."""
from pathlib import Path
from html.parser import HTMLParser
import base64
import hashlib
import json
import mimetypes
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'dist'


class Check(HTMLParser):
    def __init__(self):
        super().__init__(); self.ids=[]; self.anchors=[]; self.assets=[]; self.images=[]; self.controls=[]
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if 'id' in a:self.ids.append(a['id'])
        if tag in ('a','use') and a.get('href','').startswith('#'):self.anchors.append(a['href'][1:])
        if tag=='img':self.images.append('alt' in a)
        if 'aria-controls' in a:self.controls.extend(a['aria-controls'].split())
        for key in ('src','href'):
            if key in a and not a[key].startswith('#'):self.assets.append(a[key])
        if a.get('property')=='og:image':self.assets.append(a['content'])


def data_url(relative):
    mime=mimetypes.guess_type(relative)[0] or 'application/octet-stream'
    if relative.endswith('.woff2'):mime='font/woff2'
    return 'data:'+mime+';base64,'+base64.b64encode((DIST/relative).read_bytes()).decode()


def build():
    source=(DIST/'index.html').read_text();check=Check();check.feed(source)
    assert len(check.ids)==len(set(check.ids)), 'Duplicate IDs'
    assert set(check.anchors+check.controls)<=set(check.ids), 'Missing target'
    assert all(check.images), 'Missing image alt'
    for asset in check.assets:assert (DIST/asset).is_file(), asset
    css=(DIST/'assets/pull-forward.css').read_text()+'\n'+(DIST/'styles.css').read_text()
    css_urls=re.findall(r'url\([\'\"]?([^\)\'\"]+)',css)
    for asset in css_urls:assert (DIST/asset).is_file(),asset
    for name in ('site.js','assets/controller.js','assets/pull-forward.js'):
        assert not re.search(r'getUserMedia|\bfetch\(|XMLHttpRequest|WebSocket|localStorage|sendBeacon', (DIST/name).read_text()),name
    assert not any(re.match(r'https?://', x) for x in check.assets+css_urls), 'Remote dependency'
    # Inline assets, font faces, styles and scripts for a one-file manual opening.
    standalone=re.sub(r'\s*<link rel="stylesheet"[^>]+>', '', source)
    standalone=re.sub(r'\s*<script src="[^"]+" defer></script>', '', standalone)
    for asset in css_urls:css=css.replace(asset,data_url(asset))
    license_text=(DIST/'assets/FONT-LICENSE.txt').read_text()
    assert '</script' not in license_text.lower()
    standalone=standalone.replace('</head>', '<style>\n'+css+'\n</style>\n<script type="text/plain" id="font-license">\n'+license_text+'\n</script>\n</head>')
    for asset in sorted(set(check.assets),key=len,reverse=True):
        if asset.endswith(('.css','.js')):continue
        standalone=standalone.replace('"'+asset+'"','"'+data_url(asset)+'"')
    scripts='\n'.join((DIST/name).read_text() for name in ('assets/pull-forward.js','assets/controller.js','site.js'))
    assert '</script' not in scripts.lower(), 'Unexpected inline script terminator'
    standalone=standalone.replace('</body>', '<script>\n'+scripts+'\n</script>\n</body>')
    (ROOT/'MuseFocus.html').write_text(standalone)
    report={
        'staticValidation':'passed', 'uniqueIds':len(check.ids), 'anchorAndControlTargets':len(check.anchors+check.controls),
        'localReferences':len(check.assets)+len(css_urls), 'remoteDependencies':0,
        'browserChecked':False, 'visuals':'Pillow layout proofs; not browser screenshots',
        'interactionCheck':'node source/verify.cjs — actual mount with a controlled DOM adapter',
        'publication':'not published', 'standaloneBytes':len(standalone.encode()),
        'standaloneSha256':hashlib.sha256(standalone.encode()).hexdigest()
    }
    (ROOT/'preview/validation.json').write_text(json.dumps(report,indent=2)+'\n')
    archive=ROOT/'musefocus-website.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as zipped:
        for p in sorted(DIST.rglob('*')):
            if p.is_file():zipped.write(p,Path('musefocus-website')/p.relative_to(DIST))
        zipped.writestr('musefocus-website/README.txt', 'MuseFocus website\n\nOpen index.html manually with its adjacent files. No server or installation is needed.\n\nThis is an unpublished static introduction with an interactive product illustration. All examples are local; no account or microphone is accessed.\n\nBundled font license: assets/FONT-LICENSE.txt\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__':build()
