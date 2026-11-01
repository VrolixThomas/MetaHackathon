"""Create and verify one portable final asset ZIP, rooted at pull-forward/."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT=Path(__file__).resolve().parent.parent
ARCHIVE=ROOT/'pull-forward-assets.zip'
SUMS=ROOT/'SHA256SUMS.txt'
REPORT=ROOT/'preview/archive-validation.json'
DIGEST=ROOT/'pull-forward-assets.zip.sha256'

def deliverables():
    result=[]
    for p in sorted(ROOT.rglob('*')):
        if not p.is_file():continue
        rel=p.relative_to(ROOT)
        if p in [ARCHIVE,SUMS,REPORT,DIGEST] or any(part in ['__pycache__','.frames','.tmp'] for part in rel.parts):continue
        if p.suffix in ['.pyc','.zip'] or p.name=='.DS_Store':continue
        if p.is_symlink():raise AssertionError(f'External/symlinked content is not packaged: {p}')
        result.append(p)
    return result

base_files=deliverables()
report={'archive':ARCHIVE.name,'members':len(base_files)+2,'hashed_files':len(base_files)+1,'verified':'Every delivered file is byte-identical to its workspace source, all listed SHA-256 values are verified, ZIP CRCs pass, and member paths are safe and relative.','note':'The report and SHA256SUMS.txt are inside the ZIP. The ZIP digest is a separate .sha256 sidecar to avoid a checksum cycle.'}
REPORT.parent.mkdir(parents=True,exist_ok=True);REPORT.write_text(json.dumps(report,indent=2)+'\n')
files=base_files+[REPORT]
SUMS.write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(ROOT).as_posix()+'\n' for p in files))
with zipfile.ZipFile(ARCHIVE,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for p in files+[SUMS]:z.write(p,Path('pull-forward')/p.relative_to(ROOT))
with zipfile.ZipFile(ARCHIVE) as z:
    assert z.testzip() is None
    for p in files:
        member=(Path('pull-forward')/p.relative_to(ROOT)).as_posix()
        assert hashlib.sha256(z.read(member)).digest()==hashlib.sha256(p.read_bytes()).digest(),member
    names=z.namelist()
    assert all(n.startswith('pull-forward/') and '..' not in Path(n).parts for n in names)
assert len(names)==report['members']
digest=hashlib.sha256(ARCHIVE.read_bytes()).hexdigest();DIGEST.write_text(digest+'  '+ARCHIVE.name+'\n')
print(json.dumps({**report,'archive_bytes':ARCHIVE.stat().st_size,'archive_sha256':digest},indent=2))
