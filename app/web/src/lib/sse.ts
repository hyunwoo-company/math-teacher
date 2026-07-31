/**
 * SSE(text/event-stream) 증분 파서.
 *
 * `EventSource` 는 POST 를 못 하고 헤더도 못 붙이므로 쓰지 않는다.
 * `fetch` 의 `response.body`(ReadableStream)를 직접 읽어 여기서 파싱한다.
 *
 * 파싱 규칙은 WHATWG HTML "server-sent events" 절을 따른다.
 *  - 줄 구분자는 CRLF | CR | LF 세 가지 모두 허용
 *  - 빈 줄에서 이벤트를 디스패치
 *  - `field: value` 형태, 콜론 뒤 스페이스 1개만 제거
 *  - 콜론으로 시작하는 줄은 주석(하트비트)
 *  - `data:` 가 여러 줄이면 개행으로 이어붙임
 *  - 스트림 맨 앞의 BOM 제거
 *
 * 청크 경계 처리(여기가 버그의 원천이다):
 *  - 한 이벤트가 여러 청크에 쪼개져 와도 버퍼에 남겨 다음 청크와 합친다.
 *  - 버퍼 끝이 CR 이면 다음 청크가 LF 로 시작할 수 있으므로(=CRLF 가 청크 경계에
 *    걸린 경우) 그 CR 은 아직 줄 끝으로 처리하지 않고 보류한다.
 *  - 멀티바이트 UTF-8(한국어)이 청크 경계에 걸리는 문제는 `TextDecoder({stream:true})` 가 처리한다.
 */

/** NULL 문자. 소스에 raw 0x00 바이트를 넣지 않기 위해 코드로 만든다. */
const NUL = String.fromCharCode(0);

export interface SSEMessage {
  /** `event:` 필드. 없으면 'message'. */
  event: string;
  /** `data:` 필드들을 개행으로 이어붙인 값. */
  data: string;
  /** `id:` 필드. 없으면 null. */
  id: string | null;
  /** `retry:` 필드(정수 ms). 없으면 null. */
  retry: number | null;
}

const NEWLINE_RE = /\r\n|\r|\n/;

/** 상태를 들고 있는 증분 파서. `push()` 를 반복 호출하고 끝에 `flush()` 한다. */
export class SSEParser {
  private buffer = '';
  private bomChecked = false;

  private dataLines: string[] = [];
  private eventName: string | null = null;
  private lastId: string | null = null;
  private retry: number | null = null;
  /** 현재 이벤트 블록에 유효한 필드가 하나라도 있었는지. */
  private dirty = false;

  /**
   * 디코딩된 문자열 청크를 넣고, 그 안에서 완성된 이벤트들을 받는다.
   * 미완성 데이터는 내부 버퍼에 남는다.
   */
  push(chunk: string): SSEMessage[] {
    if (chunk === '') return [];

    this.buffer += chunk;

    if (!this.bomChecked && this.buffer.length > 0) {
      if (this.buffer.charCodeAt(0) === 0xfeff) this.buffer = this.buffer.slice(1);
      this.bomChecked = true;
    }

    const out: SSEMessage[] = [];

    for (;;) {
      const match = NEWLINE_RE.exec(this.buffer);
      if (!match) break;

      const index = match.index;
      const terminator = match[0];

      // CR 이 버퍼의 마지막 문자라면, 뒤따르는 LF 가 다음 청크에 있을 수 있다.
      // 지금 줄을 끝내면 CRLF 를 "빈 줄" 로 오인해 이벤트를 잘못 디스패치한다.
      if (terminator === '\r' && index === this.buffer.length - 1) break;

      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + terminator.length);

      const message = this.handleLine(line);
      if (message) out.push(message);
    }

    return out;
  }

  /**
   * 스트림이 끝났을 때 호출한다.
   * 마지막 이벤트 뒤에 빈 줄을 안 보내는 서버가 흔하므로 남은 내용을 디스패치한다.
   */
  flush(): SSEMessage[] {
    const out: SSEMessage[] = [];

    if (this.buffer.length > 0) {
      const line = this.buffer;
      this.buffer = '';
      const message = this.handleLine(line);
      if (message) out.push(message);
    }

    const tail = this.dispatch();
    if (tail) out.push(tail);
    return out;
  }

  /** 아직 디스패치되지 않은 부분 data (중단 시 살려 쓰려면 사용). */
  peekPartialData(): string {
    return this.dataLines.join('\n');
  }

  private handleLine(line: string): SSEMessage | null {
    if (line === '') return this.dispatch();

    // 주석 / keep-alive 는 무시한다.
    if (line.startsWith(':')) return null;

    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        this.eventName = value;
        this.dirty = true;
        break;
      case 'data':
        this.dataLines.push(value);
        this.dirty = true;
        break;
      case 'id':
        // 값에 NULL 문자가 있으면 무시하라는 스펙.
        if (!value.includes(NUL)) {
          this.lastId = value;
          this.dirty = true;
        }
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          this.retry = Number.parseInt(value, 10);
          this.dirty = true;
        }
        break;
      default:
        // 알 수 없는 필드는 무시(스펙).
        break;
    }
    return null;
  }

  private dispatch(): SSEMessage | null {
    if (!this.dirty) {
      this.reset();
      return null;
    }

    const message: SSEMessage = {
      event: this.eventName ?? 'message',
      data: this.dataLines.join('\n'),
      id: this.lastId,
      retry: this.retry,
    };
    this.reset();
    return message;
  }

  private reset(): void {
    this.dataLines = [];
    this.eventName = null;
    this.retry = null;
    this.dirty = false;
  }
}

/** 문자열 청크 배열을 한 번에 파싱한다(테스트/디버깅용). */
export function parseSSEChunks(chunks: readonly string[]): SSEMessage[] {
  const parser = new SSEParser();
  const out: SSEMessage[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  out.push(...parser.flush());
  return out;
}

/**
 * `fetch` 응답 바디를 SSE 메시지 스트림으로 바꾼다.
 *
 * @param body `Response.body`
 * @param signal 중단 시그널(중단되면 조용히 종료한다)
 */
export async function* iterateSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEMessage, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const parser = new SSEParser();

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true -> 멀티바이트 문자가 청크 경계에 걸려도 안전하다.
      const text = decoder.decode(value, { stream: true });
      for (const message of parser.push(text)) yield message;
    }
    const tailText = decoder.decode();
    if (tailText) {
      for (const message of parser.push(tailText)) yield message;
    }
    for (const message of parser.flush()) yield message;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}
