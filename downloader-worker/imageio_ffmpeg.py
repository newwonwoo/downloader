"""Compatibility shim for the existing Render build command.

Render currently executes:
  python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'

Keep that command unchanged while sourcing executables from static-ffmpeg.
Only the executable path may reach stdout because the shell captures stdout
inside command substitution.
"""

from contextlib import redirect_stdout
from pathlib import Path
import sys

from static_ffmpeg import run


def _executables():
    with redirect_stdout(sys.stderr):
        ffmpeg, ffprobe = run.get_or_fetch_platform_executables_else_raise()
    ffmpeg = Path(ffmpeg).expanduser().resolve()
    ffprobe = Path(ffprobe).expanduser().resolve()
    if not ffmpeg.is_file():
        raise RuntimeError(f'ffmpeg binary not found: {ffmpeg}')
    if not ffprobe.is_file():
        raise RuntimeError(f'ffprobe binary not found: {ffprobe}')
    return ffmpeg, ffprobe


def get_ffmpeg_exe():
    return str(_executables()[0])


def get_ffprobe_exe():
    return str(_executables()[1])
