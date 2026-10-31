"""Build original vector assets and the offline motion lab. No third-party inputs."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
MARKS = {
    'openfold': [
        'M16 53C10 34 24 14 45 14C58 14 68 20 74 30C57 31 43 42 37 59C33 70 22 70 16 53Z',
        'M84 47C90 66 76 86 55 86C42 86 32 80 26 70C43 69 57 58 63 41C67 30 78 30 84 47Z',
    ],
    'cadence': [
        'M12 79V39C12 7 45 9 50 35L43 56C40 32 29 27 29 43V79Z',
        'M50 35C55 9 88 7 88 39V79H71V43C71 27 60 32 57 56H43Z',
    ],
    'lumen': [
        'M10 46C22 15 67 12 88 38C65 28 40 35 24 51C18 57 12 54 10 46Z',
        'M90 54C78 85 33 88 12 62C35 72 60 65 76 49C82 43 88 46 90 54Z',
    ],
}
# Original geometric lettering, not dependent on an installed font.
WORD = '<g fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 40V17M4 24C4 12 23 12 23 24V40M23 24C23 12 42 12 42 24V40M56 17V30C56 45 78 45 78 30V17M115 19C110 13 92 14 92 23C92 32 115 27 115 35C115 44 98 45 91 39M131 29H155C155 10 129 11 129 28C129 44 147 45 155 38"/></g>'

def glyph(name, color='currentColor'):
    return '<g fill="'+color+'">'+''.join('<path d="'+d+'"/>' for d in MARKS[name])+'</g>'

def svg(body, box='0 0 100 100', label='Muse'):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}" role="img" aria-label="{label}">{body}</svg>\n'

for name in MARKS:
    dest = ROOT / 'assets' / name
    dest.mkdir(exist_ok=True)
    for treatment, color in [('mono', 'currentColor'), ('ink', '#242523'), ('chalk', '#F4F3EC')]:
        (dest/f'mark-{treatment}.svg').write_text(svg(glyph(name, color), label=f'Muse {name}'))
    for treatment, fg, bg in [('light','#242523','#F4F3EC'),('dark','#F4F3EC','#242523')]:
        body=f'<rect x="0" y="0" width="100" height="100" rx="23" fill="{bg}"/><g transform="translate(13 13) scale(.74)">{glyph(name,fg)}</g>'
        (dest/f'app-icon-{treatment}.svg').write_text(svg(body,label=f'Muse {name} app icon'))
        body=f'<g color="{fg}"><g transform="translate(0 2) scale(.64)">{glyph(name)}</g><g transform="translate(85 6) scale(1.23)">{WORD}</g></g>'
        (dest/f'lockup-{treatment}.svg').write_text(svg(body,'0 0 288 70',f'Muse {name} wordmark'))
    (dest/'wordmark.svg').write_text(svg(WORD,'0 0 162 52','Muse wordmark'))

# Static pose exports use the same base poses as the controller. Preview QA checks
# them against the actual reduced-motion DOM. No animation in these files.
POSES = {'idle': (0,0,1), 'listening': (4,-5,.95), 'thinking': (-2,3,.91),
         'speaking': (7,-9,.95), 'needs-input': (8,-10,.94),
         'success': (0,0,1), 'error': (-2,0,.94), 'offline': (-2,0,.9)}
BADGES = {'idle': '', 'listening': 'M44 51V47M50 56V42M56 51V47',
          'thinking': 'M44 49H56M44 55H52', 'speaking': 'M43 53V47M50 58V42M57 53V47',
          'needs-input': 'M45 46C45 39 57 39 57 46C57 50 50 50 50 55M50 61V62',
          'success': 'M42 51L48 57L60 43', 'error': 'M50 41V52M50 59V60',
          'offline': 'M42 43L58 59M42 59L58 43'}
state_dir = ROOT/'assets'/'openfold'/'static'
state_dir.mkdir(exist_ok=True)
for state, (spread, angle, scale) in POSES.items():
    for theme, fg, bg in [('light','#242523','#F4F3EC'),('dark','#F4F3EC','#242523')]:
        body = '<g fill="'+fg+'"'+(' opacity=".56"' if state == 'offline' else '')+'>'
        for i, path in enumerate(MARKS['openfold']):
            sign = 1 if i else -1
            transform = f'translate({spread*sign*.7:.3f} {spread*sign:.3f}) translate(50 50) rotate({angle*sign:.3f}) scale({scale:.4f}) translate(-50 -50)'
            body += f'<path d="{path}" transform="{transform}"/>'
        if state != 'idle':
            body += f'<g transform="translate(29 29) scale(.58)" fill="none" stroke="{fg}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><circle cx="50" cy="50" r="21" fill="{bg}" stroke="none"/><path d="{BADGES[state]}"/></g>'
        body += '</g>'
        (state_dir/f'{state}-{theme}.svg').write_text(svg(body,label=f'Muse: {state.replace("-", " ")}'))
(ROOT/'assets'/'paths.json').write_text(json.dumps(MARKS,indent=2)+'\n')

# The readable, reusable source is also embedded in index.html for file:// use.
template = (ROOT/'preview.template.html').read_text()
script = (ROOT/'muse-mark.js').read_text()
data = json.dumps(MARKS, separators=(',',':'))
template=template.replace('/*__COMPONENT__*/',script).replace('/*__MARK_DATA__*/',data).replace('<!--__WORDMARK__-->',WORD)
(ROOT/'index.html').write_text(template)
print('Built 40 SVG assets, path data and self-contained index.html')
