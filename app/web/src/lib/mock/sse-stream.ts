/**
 * 목 모드용 SSE 바이트 스트림 생성기.
 *
 * 목이라고 이벤트 객체를 그냥 넘기지 않는다. 실제 서버처럼 `text/event-stream` 바이트를
 * 만들어 `iterateSSE()` 로 파싱하게 한다. 그래야 목 모드로 UI 를 돌릴 때
 * SSE 파서까지 같이 검증된다.
 *
 * - 줄바꿈은 CRLF (`sse-starlette` 등 파이썬 SSE 구현이 CRLF 를 쓴다)
 * - 청크 크기를 일부러 들쭉날쭉하게 잘라 이벤트 경계가 청크 중간에 걸리게 만든다
 * - 한 청크에 여러 이벤트가 들어가는 경우도 발생시킨다
 */

export interface MockSseEvent {
  event: string;
  data: unknown;
  /** 이 이벤트를 보내기 전 대기 시간(ms). */
  delayMs?: number;
}

/** 청크 크기 패턴(바이트). 1 은 멀티바이트 문자 중간을 자르게 만든다. */
const CHUNK_PATTERN = [7, 1, 41, 3, 160];

const encoder = new TextEncoder();

function serialize(event: MockSseEvent, newline: string): string {
  return `event: ${event.event}${newline}data: ${JSON.stringify(event.data)}${newline}${newline}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 이벤트 스크립트를 SSE 바이트 스트림으로 만든다.
 *
 * @param script 이벤트를 순서대로 내놓는 async generator
 * @param signal 중단 시그널
 */
export function mockSseStream(
  script: AsyncGenerator<MockSseEvent, void, void>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const newline = '\r\n';
  let patternIndex = 0;
  let pending = new Uint8Array(0);

  const append = (text: string) => {
    const bytes = encoder.encode(text);
    const merged = new Uint8Array(pending.length + bytes.length);
    merged.set(pending, 0);
    merged.set(bytes, pending.length);
    pending = merged;
  };

  const takeChunk = (): Uint8Array | null => {
    if (pending.length === 0) return null;
    const size = CHUNK_PATTERN[patternIndex % CHUNK_PATTERN.length] ?? 16;
    patternIndex += 1;
    const take = Math.min(size, pending.length);
    const chunk = pending.slice(0, take);
    pending = pending.slice(take);
    return chunk;
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (;;) {
          if (signal?.aborted) break;
          const next = await script.next();
          if (next.done) break;
          const event = next.value;
          if (event.delayMs && event.delayMs > 0) await sleep(event.delayMs);
          if (signal?.aborted) break;

          append(serialize(event, newline));

          // 버퍼를 대부분 흘려보내되 꼬리는 남긴다 -> 다음 이벤트와 이어붙어 전송된다.
          let guard = 0;
          while (pending.length > 24 && guard < 64) {
            const chunk = takeChunk();
            if (!chunk) break;
            controller.enqueue(chunk);
            guard += 1;
          }
        }

        // 남은 꼬리를 모두 내보낸다.
        for (;;) {
          const chunk = takeChunk();
          if (!chunk) break;
          controller.enqueue(chunk);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      void script.return();
    },
  });
}
