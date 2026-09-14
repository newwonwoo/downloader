# Downloader

Standalone video downloader migrated from `newwonwoo/unisquads`.

## Layout

- `/` — static downloader UI for Vercel
- `api/` — resolver and media proxy Vercel Functions
- `downloader-worker/` — Render FastAPI worker that prepares complete MP4 files

## Render worker

Build command:

```sh
cd downloader-worker && pip install -r requirements.txt && mkdir -p .bin && ln -sf "$(python -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')" .bin/ffmpeg
```

Start command:

```sh
cd downloader-worker && PATH="$PWD/.bin:$PATH" uvicorn app:app --host 0.0.0.0 --port $PORT
```

The UI only supports public, non-DRM HLS media that the user is authorized to save.
