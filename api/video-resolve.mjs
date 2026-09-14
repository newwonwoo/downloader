const SOURCE_HOSTS = new Set(['njavtv.com', 'www.njavtv.com']);
const QUALITY_ORDER = ['1920x1080', '1080p', '1280x720', '1280p', '720p', '842x480', '480p', '640x360', '360p'];
const VERIFIED_GENERATED_QUALITIES = new Map([
  ['fee1f896-c34b-4caa-a712-0e8241e38cfc', ['1280x720', '842x480', '640x360']],
]);
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}

function decodeHtml(value = '') {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/');
}

function stripTags(value = '') {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

export function parseNjavHtml(html, pageUrl) {
  const normalized = decodeHtml(String(html || ''));
  const title = stripTags(
    normalized.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ||
      normalized.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ||
      'video'
  )
    .replace(/\s*[-|]\s*NJAVTV.*$/i, '')
    .trim();

  const uuidPatterns = [
    /(?:nineyu|surrit)\.com\/+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i,
    /["'](?:videoId|video_id|uuid|fileId|file_id)["']\s*[:=]\s*["']([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})["']/i,
  ];
  const videoId = uuidPatterns.map((pattern) => normalized.match(pattern)?.[1]).find(Boolean) || null;

  const directUrls = [];
  const urlPattern = /https?:\/\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
  for (const match of normalized.matchAll(urlPattern)) {
    try {
      const absolute = new URL(match[0], pageUrl).toString();
      if (!directUrls.includes(absolute)) directUrls.push(absolute);
    } catch {}
  }

  const qualities = QUALITY_ORDER.filter((quality) => {
    const escaped = quality.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^0-9a-z])${escaped}(?:$|[^0-9a-z])`, 'i').test(normalized);
  });

  const candidates = directUrls.map((url) => ({
    quality: qualityFromUrl(url) || '자동',
    url,
    source: 'page',
  }));

  if (videoId) {
    const verified = VERIFIED_GENERATED_QUALITIES.get(videoId);
    const generatedQualities = verified || qualities.filter((quality) => /^\d+x\d+$/i.test(quality));
    for (const quality of generatedQualities) {
      const url = `https://surrit.com/${videoId}/${quality}/video.m3u8`;
      if (!candidates.some((item) => item.url === url)) {
        candidates.push({ quality, url, source: verified ? 'verified-pattern' : 'known-pattern' });
      }
    }
  }

  return {
    title: title || 'video',
    videoId,
    pageUrl,
    candidates,
    cloudflareDetected: /cf-chl-|cloudflare|just a moment/i.test(normalized),
  };
}

function qualityFromUrl(url) {
  return QUALITY_ORDER.find((quality) => url.toLowerCase().includes(quality.toLowerCase())) || null;
}

function rankQuality(quality) {
  const index = QUALITY_ORDER.indexOf(quality);
  return index === -1 ? QUALITY_ORDER.length : index;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function probeCandidate(candidate, pageUrl) {
  try {
    const response = await fetchWithTimeout(
      candidate.url,
      {
        redirect: 'follow',
        headers: {
          'User-Agent': UA,
          Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
          Referer: pageUrl,
          Origin: new URL(pageUrl).origin,
        },
      },
      6500
    );

    const contentType = response.headers.get('content-type') || '';
    const text = response.ok ? await response.text() : '';
    const isManifest = response.ok && (/mpegurl|text\/plain/i.test(contentType) || text.includes('#EXTM3U'));

    return {
      ...candidate,
      url: response.url || candidate.url,
      available: isManifest,
      httpStatus: response.status,
      manifestType: text.includes('#EXT-X-STREAM-INF') ? 'master' : text.includes('#EXTINF') ? 'media' : 'unknown',
    };
  } catch (error) {
    return {
      ...candidate,
      available: false,
      httpStatus: 0,
      error: error?.name === 'AbortError' ? 'timeout' : 'unreachable',
    };
  }
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204 });
    }
    if (request.method !== 'POST') {
      return jsonResponse(405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'POST 요청만 지원합니다.' });
    }

    let pageUrl;
    try {
      const raw = await request.json();
      pageUrl = new URL(String(raw?.url || '').trim());
      if (pageUrl.protocol !== 'https:' || !SOURCE_HOSTS.has(pageUrl.hostname.toLowerCase())) {
        throw new Error('unsupported host');
      }
    } catch {
      return jsonResponse(400, { ok: false, code: 'INVALID_URL', message: 'NJAVTV의 https 영상 주소를 입력하세요.' });
    }

    try {
      const response = await fetchWithTimeout(
        pageUrl.toString(),
        {
          redirect: 'follow',
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6',
            'Cache-Control': 'no-cache',
            Pragma: 'no-cache',
          },
        },
        9000
      );

      const html = await response.text();
      const parsed = parseNjavHtml(html, pageUrl.toString());

      if (!response.ok || parsed.cloudflareDetected) {
        return jsonResponse(409, {
          ok: false,
          code: 'SOURCE_BLOCKED',
          message: '원본 사이트가 서버 접속을 차단했습니다. 잠시 뒤 다시 시도하거나 원본 페이지를 먼저 열어 재생해 주세요.',
          status: response.status,
        });
      }

      if (!parsed.candidates.length) {
        return jsonResponse(422, {
          ok: false,
          code: 'STREAM_NOT_FOUND',
          message: '영상 스트림 주소를 찾지 못했습니다. 원본 페이지에서 영상이 정상 재생되는지 확인하세요.',
        });
      }

      const probes = await Promise.all(parsed.candidates.slice(0, 10).map((candidate) => probeCandidate(candidate, pageUrl.toString())));
      const available = probes
        .filter((item) => item.available)
        .sort((a, b) => rankQuality(a.quality) - rankQuality(b.quality));

      const streams = available.length
        ? available
        : probes
            .filter((item) => item.source === 'page')
            .sort((a, b) => rankQuality(a.quality) - rankQuality(b.quality));

      if (!streams.length) {
        return jsonResponse(422, {
          ok: false,
          code: 'STREAM_UNAVAILABLE',
          message: '후보 주소는 찾았지만 현재 재생 가능한 스트림을 확인하지 못했습니다.',
          videoId: parsed.videoId,
        });
      }

      return jsonResponse(200, {
        ok: true,
        title: parsed.title,
        videoId: parsed.videoId,
        pageUrl: parsed.pageUrl,
        streams: streams.map(({ quality, url, available, manifestType }) => ({ quality, url, available, manifestType })),
        limitations: ['DRM 스트림은 지원하지 않음', '저장이 허용된 영상만 사용'],
      });
    } catch (error) {
      return jsonResponse(502, {
        ok: false,
        code: error?.name === 'AbortError' ? 'SOURCE_TIMEOUT' : 'SOURCE_ERROR',
        message: error?.name === 'AbortError' ? '원본 사이트 응답 시간이 초과됐습니다.' : '원본 페이지를 불러오지 못했습니다.',
      });
    }
  },
};
