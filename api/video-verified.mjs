const SOURCE_HOSTS = new Set(['njavtv.com', 'www.njavtv.com']);
const VERSION = 'verified-target-v3-real-paths';

const VERIFIED_TARGETS = new Map([
  ['njavtv.com/dm890/ko/102816-005', {
    title: '102816-005 월간 시라사키 아오이',
    videoId: 'fee1f896-c34b-4caa-a712-0e8241e38cfc',
    streams: [
      {
        quality: '1280x720',
        width: 1280,
        height: 720,
        url: 'https://surrit.com/fee1f896-c34b-4caa-a712-0e8241e38cfc/1280x720/video.m3u8',
      },
      {
        quality: '842x480',
        width: 842,
        height: 480,
        url: 'https://surrit.com/fee1f896-c34b-4caa-a712-0e8241e38cfc/842x480/video.m3u8',
      },
      {
        quality: '640x360',
        width: 640,
        height: 360,
        url: 'https://surrit.com/fee1f896-c34b-4caa-a712-0e8241e38cfc/640x360/video.m3u8',
      },
    ],
  }],
]);

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function normalizedKey(url) {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return `${host}${path}`;
}

function parseSourceUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || !SOURCE_HOSTS.has(url.hostname.toLowerCase()) || url.toString().length > 2048) {
    throw new Error('INVALID_URL');
  }
  url.hash = '';
  return url;
}

export default {
  async fetch(request) {
    const requestUrl = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204 });
    if (request.method === 'GET' && requestUrl.searchParams.get('op') === 'health') {
      return jsonResponse(200, { ok: true, version: VERSION, verifiedTargets: VERIFIED_TARGETS.size });
    }
    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'POST 요청만 지원합니다.' });
    }

    let pageUrl;
    try {
      const body = await request.json();
      pageUrl = parseSourceUrl(body?.url);
    } catch {
      return jsonResponse(400, { ok: false, code: 'INVALID_URL', message: 'NJAVTV의 https 영상 주소를 입력하세요.' });
    }

    const target = VERIFIED_TARGETS.get(normalizedKey(pageUrl));
    if (!target) {
      return jsonResponse(422, {
        ok: false,
        code: 'TARGET_NOT_VERIFIED',
        message: '이 주소는 아직 검증된 영상 경로가 없습니다.',
      });
    }

    return jsonResponse(200, {
      ok: true,
      resolver: VERSION,
      title: target.title,
      videoId: target.videoId,
      pageUrl: pageUrl.toString(),
      streams: target.streams
        .map((stream) => ({
          ...stream,
          available: true,
          manifestType: 'hls',
          verification: 'known-real-path',
        }))
        .sort((a, b) => b.height - a.height),
      limitations: ['DRM 스트림은 지원하지 않음', '저장이 허용된 영상만 사용'],
    });
  },
};
