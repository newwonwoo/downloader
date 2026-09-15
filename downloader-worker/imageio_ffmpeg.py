"""Small build-time FFmpeg bootstrap used by the existing Render command.

The worker needs a known-good static FFmpeg but does not need the publishing
stack accidentally declared by the upstream static-ffmpeg package. Download the
pinned ffmpeg-bins2 asset, verify SHA-256, and expose the same tiny API Render
already calls.
"""

import hashlib
import os
from pathlib import Path
import platform
import shutil
import sys
import tempfile
import urllib.request
import zipfile

VERSION = '8.1.2'
ASSETS = {
    'x86_64': (
        'https://github.com/zackees/ffmpeg-bins2/releases/download/v8.1.2/linux_x64.zip',
        '150f20cfa659754115b74c2aa32f0e1aa150d08a14191156875c8efeb5713b29',
    ),
    'aarch64': (
        'https://github.com/zackees/ffmpeg-bins2/releases/download/v8.1.2/linux_arm64.zip',
        'a7c8ea67d87f97dcbfcb76bd48b0dadf92ccdad2acb77422e4597ba5e97c9093',
    ),
}
CACHE = Path(__file__).with_name('.ffmpeg-bin') / VERSION


def _arch():
    value = platform.machine().lower()
    if value in ('x86_64', 'amd64', 'x64'):
        return 'x86_64'
    if value in ('aarch64', 'arm64'):
        return 'aarch64'
    raise RuntimeError(f'unsupported FFmpeg architecture: {value}')


def _digest(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _find(root, name):
    candidates = [item for item in root.rglob(name) if item.is_file()]
    if not candidates:
        raise RuntimeError(f'{name} missing from FFmpeg archive')
    return candidates[0]


def _install():
    if not sys.platform.startswith('linux'):
        raise RuntimeError(f'unsupported FFmpeg platform: {sys.platform}')
    arch = _arch()
    target = CACHE / arch
    ffmpeg = target / 'ffmpeg'
    ffprobe = target / 'ffprobe'
    if ffmpeg.is_file() and ffprobe.is_file():
        return ffmpeg, ffprobe

    url, expected = ASSETS[arch]
    target.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ffmpeg-bootstrap-') as tmp:
        tmpdir = Path(tmp)
        archive = tmpdir / 'ffmpeg.zip'
        request = urllib.request.Request(url, headers={'User-Agent': 'unisquads-downloader-build/1'})
        print(f'Fetching FFmpeg {VERSION} for {arch}', file=sys.stderr, flush=True)
        with urllib.request.urlopen(request, timeout=120) as response, archive.open('wb') as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        actual = _digest(archive)
        if actual != expected:
            raise RuntimeError(f'FFmpeg SHA-256 mismatch: expected {expected}, got {actual}')
        extracted = tmpdir / 'unzipped'
        extracted.mkdir()
        with zipfile.ZipFile(archive) as bundle:
            bundle.extractall(extracted)
        for name, destination in (('ffmpeg', ffmpeg), ('ffprobe', ffprobe)):
            source = _find(extracted, name)
            shutil.copy2(source, destination)
            destination.chmod(0o755)
    return ffmpeg.resolve(), ffprobe.resolve()


def get_ffmpeg_exe():
    return str(_install()[0])


def get_ffprobe_exe():
    return str(_install()[1])
