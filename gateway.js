(() => {
  const nativeFetch = window.fetch.bind(window);
  const WORKER = 'https://downloader-worker-brm7.onrender.com';
  const WARM_TTL_MS = 10 * 60 * 1000;
  let readyAt = 0;
  let warmPromise = null;

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return input?.url || '';
  }

  function isPath(value, path) {
    try {
      return new URL(value, window.location.origin).pathname === path;
    } catch {
      return false;
    }
  }

  async function warmWorker(force = false) {
    if (!force && readyAt && Date.now() - readyAt < WARM_TTL_MS) return true;
    if (warmPromise) return warmPromise;

    warmPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      try {
        const response = await nativeFetch(`${WORKER}/health`, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'omit',
          signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || data?.ok !== true) throw new Error('worker not ready');
        readyAt = Date.now();
        return true;
      } finally {
        clearTimeout(timer);
      }
    })().finally(() => { warmPromise = null; });

    return warmPromise;
  }

  window.warmDownloaderWorker = warmWorker;

  window.fetch = async (input, init = {}) => {
    const value = requestUrl(input);
    if (!isPath(value, '/api/video-resolve')) return nativeFetch(input, init);

    const resolve = () => nativeFetch(`${WORKER}/resolve`, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
    });

    try {
      const response = await resolve();
      if (response.ok) readyAt = Date.now();
      return response;
    } catch {
      try {
        await warmWorker(true);
        const response = await resolve();
        if (response.ok) readyAt = Date.now();
        return response;
      } catch {
        throw new TypeError('영상 분석 서버에 연결하지 못했습니다.');
      }
    }
  };

  void warmWorker().catch(() => {});
})();
