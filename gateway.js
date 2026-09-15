(() => {
  const nativeFetch = window.fetch.bind(window);
  const WORKER = 'https://downloader-worker-brm7.onrender.com';

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

  window.fetch = async (input, init = {}) => {
    const value = requestUrl(input);
    if (!isPath(value, '/api/video-resolve')) return nativeFetch(input, init);

    try {
      return await nativeFetch(`${WORKER}/resolve`, {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
      });
    } catch {
      throw new TypeError('영상 분석 서버에 연결하지 못했습니다.');
    }
  };
})();
