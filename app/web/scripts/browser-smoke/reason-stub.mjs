/**
 * 8101(구독 비활성 백엔드) 앞에 두는 얇은 프록시.
 *
 * 현재 백엔드는 `availability()` 에 reason 이 있는데도 `/api/env` 응답에 넣지 않는다
 * (main.py 가 SubscriptionInfo 에 전달하지 않고, schemas.py 에 필드도 없다).
 * 그래서 계약(ARCHITECTURE.md 5항)대로 reason 이 오는 경우의 UI 를 검증할 수 없다.
 *
 * 이 프록시는 `/api/env` 응답에만 `subscription.reason` 을 주입한다.
 * **프론트엔드 검증 전용이며 제품 코드가 아니다.**
 */
import { createServer } from 'node:http';

const UPSTREAM = process.env.UPSTREAM ?? 'http://127.0.0.1:8101';
const PORT = Number(process.env.PORT ?? 8102);
const REASON = process.env.REASON ?? 'disabled';

createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', UPSTREAM);
  const body =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await new Promise((resolve) => {
          const chunks = [];
          request.on('data', (chunk) => chunks.push(chunk));
          request.on('end', () => resolve(Buffer.concat(chunks)));
        });

  const headers = { ...request.headers };
  delete headers.host;

  try {
    const upstream = await fetch(url, { method: request.method, headers, body });
    const isEnv = url.pathname === '/api/env';

    // REASON=none 이면 주입하지 않고 그대로 넘긴다(= 실제 백엔드 응답 그대로 + CORS 허용).
    if (isEnv && upstream.ok) {
      const data = await upstream.json();
      if (REASON !== 'none') {
        data.subscription = { ...data.subscription, reason: REASON };
      }
      const text = JSON.stringify(data);
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      });
      response.end(text);
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    const outHeaders = {
      'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    };
    response.writeHead(upstream.status, outHeaders);
    response.end(buffer);
  } catch (error) {
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error_code: 'proxy', message: String(error), hint: null }));
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`reason-stub: http://127.0.0.1:${PORT} -> ${UPSTREAM} (reason="${REASON}")`);
});
