"""Build a small, explicit source-only GitHub handoff archive."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'release' / 'qmx-acm-notebook-source.zip'
FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc',
         '.gitignore', 'README.md', 'CONTRIBUTING.md', '启动客户端.cmd']
DIRS = ['electron', 'ui', 'tools', 'tests', 'docs', '.github']

def main():
    selected = [ROOT / name for name in FILES]
    for name in DIRS:
        selected.extend(p for p in (ROOT / name).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
    selected.extend(ROOT / 'screenshots' / f'preview-{theme}.png' for theme in ['light', 'dark', 'cards'])
    OUTPUT.parent.mkdir(exist_ok=True)
    with ZipFile(OUTPUT, 'w', ZIP_DEFLATED) as archive:
        for source in sorted(selected):
            archive.write(source, source.relative_to(ROOT).as_posix())
    with ZipFile(OUTPUT) as archive:
        names = archive.namelist()
        forbidden = {'node_modules', 'release', '.test-profile', '.package-stage', '.electron-zip'}
        assert not any(forbidden.intersection(Path(n).parts) for n in names)
        assert not any(Path(n).name in {'auth.json', 'local.json', 'cache.json', 'settings.json'} for n in names)
        assert {'package.json', '.github/workflows/ci.yml', '.github/workflows/release.yml'}.issubset(names)
        json.loads(archive.read('package.json'))
        assert archive.testzip() is None
    print(f'{OUTPUT}\n{len(names)} files, {OUTPUT.stat().st_size} bytes; source-only checks passed')

if __name__ == '__main__':
    main()
