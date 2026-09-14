import directResolver from './video-resolve.mjs';
import verifiedResolver from './video-verified.mjs';
import browserResolver from './video.mjs';
import mediaProxy from './video-fetch.mjs';

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

async function dispatch(request) {
  const url = new URL(request.url);
  const stage = url.searchParams.get('stage') || '';

  if (stage === 'direct') return directResolver.fetch(request);
  if (stage === 'verified') return verifiedResolver.fetch(request);
  if (stage === 'browser') return browserResolver.fetch(request);
  if (stage === 'media') return mediaProxy.fetch(request);

  return jsonResponse(400, {
    ok: false,
    code: 'INVALID_STAGE',
    message: '지원하지 않는 다운로드 처리 단계입니다.',
  });
}

export async function GET(request) {
  return dispatch(request);
}

export async function POST(request) {
  return dispatch(request);
}

export async function OPTIONS(request) {
  return dispatch(request);
}
