const ALLOWED_SUFFIXES = ['surrit.com', 'nineyu.com'];
const UA = 'Mozilla/5.0 (Linux; Android 13; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Mobile Safari/537.36';

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export default {
  async fetch(request) {
    if (request.method !== 'GET') {
      return jsonResponse(405, { ok: false, message: 'GET 요청만 지원합니다.' });
    }

    let target;
    try {
      const requestUrl = new URL(request.url);
      target = new URL(requestUrl.searchParams.get('url') || '');
      if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) throw new Error('blocked');
    } catch {
      return jsonResponse(400, { ok: false, message: '허용되지 않은 미디어 주소입니다.' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 14000);

    try {
      const headers = {
        'User-Agent': UA,
        Accept: request.headers.get('accept') || '*/*',
        Referer: 'https://njavtv.com/',
        Origin: 'https://njavtv.com',
      };
      const range = request.headers.get('range');
      if (range) headers.Range = range;

      const upstream = await fetch(target.toString(), {
        method: 'GET',
        redirect: 'follow',
        headers,
        signal: controller.signal,
      });

      const responseHeaders = new Headers();
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value) responseHeaders.set(name, value);
      }
      responseHeaders.set('Cache-Control', 'private, max-age=300');
      responseHeaders.set('X-Content-Type-Options', 'nosniff');

      return new Response(upstream.body, {
        status: upstream.status,
        headers: responseHeaders,
      });
    } catch (error) {
      return jsonResponse(error?.name === 'AbortError' ? 504 : 502, {
        ok: false,
        message: error?.name === 'AbortError' ? '미디어 서버 응답 시간이 초과됐습니다.' : '미디어를 불러오지 못했습니다.',
      });
    } finally {
      clearTimeout(timer);
    }
  },
};
