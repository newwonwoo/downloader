# Downloader

Standalone video downloader migrated from `newwonwoo/unisquads`.

**Deployment target: Render only.**

## Production architecture

- `/` — static downloader UI served by Render (`downloader-web`)
- `gateway.js` — connects the UI directly to the Render worker
- `file-job-client.js` — prepares and resumes complete MP4 file jobs
- `downloader-worker/` — Render FastAPI worker for resolving HLS, remuxing to MP4, and temporary file delivery
- `.github/workflows/` — integration and production smoke gates

There is no Vercel runtime in the active application path.

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
