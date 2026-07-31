/**
 * SSE 파서 테스트.
 *
 * 실제 서버는 이벤트 단위로 깔끔하게 끊어 주지 않는다.
 * TCP/프록시 경계에서 임의로 쪼개지므로 다음을 반드시 커버한다.
 *  - 한 이벤트가 여러 청크에 걸침
 *  - 한 청크에 여러 이벤트
 *  - CRLF 가 청크 경계에서 갈라짐(가장 흔한 버그)
 *  - 멀티바이트(한국어)가 바이트 경계에서 갈라짐
 */

import { describe, expect, it } from 'vitest';
import { SSEParser, iterateSSE, parseSSEChunks, type SSEMessage } from '@/lib/sse';

function names(messages: SSEMessage[]): string[] {
  return messages.map((message) => message.event);
}

function datas(messages: SSEMessage[]): string[] {
  return messages.map((message) => message.data);
}

describe('SSEParser', () => {
  it('LF 로 끝나는 단일 이벤트를 파싱한다', () => {
    const messages = parseSSEChunks(['event: start\ndata: {"total": 22}\n\n']);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: 'start', data: '{"total": 22}' });
  });

  it('CRLF 로 끝나는 단일 이벤트를 파싱한다', () => {
    const messages = parseSSEChunks(['event: start\r\ndata: {"total": 22}\r\n\r\n']);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('{"total": 22}');
  });

  it('한 청크에 들어온 여러 이벤트를 모두 뽑는다', () => {
    const chunk =
      'event: problem\ndata: {"no":1}\n\n' +
      'event: delta\ndata: {"no":1,"text":"가"}\n\n' +
      'event: delta\ndata: {"no":1,"text":"나"}\n\n';
    const messages = parseSSEChunks([chunk]);
    expect(names(messages)).toEqual(['problem', 'delta', 'delta']);
    expect(datas(messages)).toEqual([
      '{"no":1}',
      '{"no":1,"text":"가"}',
      '{"no":1,"text":"나"}',
    ]);
  });

  it('이벤트 하나가 두 청크에 걸쳐 와도 합쳐서 파싱한다', () => {
    const parser = new SSEParser();
    const first = parser.push('event: del');
    expect(first).toHaveLength(0);
    const second = parser.push('ta\ndata: {"no":3,"te');
    expect(second).toHaveLength(0);
    const third = parser.push('xt":"부분"}\n\n');
    expect(third).toHaveLength(1);
    expect(third[0]).toMatchObject({ event: 'delta', data: '{"no":3,"text":"부분"}' });
  });

  it('CRLF 가 청크 경계에서 갈라져도 빈 줄로 오인하지 않는다', () => {
    const parser = new SSEParser();
    // "event: done\r" 까지만 도착 -> CR 은 아직 줄 끝으로 확정하면 안 된다.
    expect(parser.push('event: done\r')).toHaveLength(0);
    expect(parser.push('\ndata: {"no":1}\r')).toHaveLength(0);
    // 여기서 '\n\r\n' 이 와야 비로소 이벤트가 끝난다.
    const messages = parser.push('\n\r\n');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ event: 'done', data: '{"no":1}' });
  });

  it('이벤트 구분용 빈 줄(CRLF)이 청크 경계에 걸려도 정확히 한 번만 디스패치한다', () => {
    const parser = new SSEParser();
    const first = parser.push('event: a\r\ndata: 1\r\n\r');
    expect(first).toHaveLength(0);
    const second = parser.push('\nevent: b\r\ndata: 2\r\n\r\n');
    expect(names(second)).toEqual(['a', 'b']);
    expect(datas(second)).toEqual(['1', '2']);
  });

  it('한 글자씩 쪼개 넣어도 결과가 같다', () => {
    const source =
      'event: start\r\ndata: {"total":2}\r\n\r\n' +
      ': keep-alive\r\n\r\n' +
      'event: end\r\ndata: {"total_cost":null}\r\n\r\n';

    const whole = parseSSEChunks([source]);
    const oneByOne = parseSSEChunks([...source]);
    expect(oneByOne).toEqual(whole);
    expect(names(whole)).toEqual(['start', 'end']);
  });

  it('data 가 여러 줄이면 개행으로 이어붙인다', () => {
    const messages = parseSSEChunks(['event: done\ndata: 첫째 줄\ndata: 둘째 줄\n\n']);
    expect(messages[0]?.data).toBe('첫째 줄\n둘째 줄');
  });

  it('주석(하트비트) 줄은 무시한다', () => {
    const messages = parseSSEChunks([': ping\n\n', 'event: delta\ndata: x\n\n']);
    expect(names(messages)).toEqual(['delta']);
  });

  it('콜론 뒤 스페이스는 하나만 제거한다', () => {
    const messages = parseSSEChunks(['data:  두칸\n\n']);
    expect(messages[0]?.data).toBe(' 두칸');
  });

  it('콜론이 없는 줄은 값이 빈 필드로 처리한다', () => {
    const messages = parseSSEChunks(['data\n\n']);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.data).toBe('');
  });

  it('event 필드가 없으면 message 로 본다', () => {
    const messages = parseSSEChunks(['data: {"a":1}\n\n']);
    expect(messages[0]?.event).toBe('message');
  });

  it('스트림 선두의 BOM 을 제거한다', () => {
    const messages = parseSSEChunks(['﻿event: start\ndata: {}\n\n']);
    expect(messages[0]?.event).toBe('start');
  });

  it('마지막 이벤트 뒤에 빈 줄이 없어도 flush 로 회수한다', () => {
    const parser = new SSEParser();
    expect(parser.push('event: end\ndata: {"total_usage":null}\n')).toHaveLength(0);
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ event: 'end', data: '{"total_usage":null}' });
  });

  it('빈 줄이 연속으로 와도 빈 이벤트를 만들지 않는다', () => {
    const messages = parseSSEChunks(['\n\n\n', 'event: delta\ndata: 1\n\n', '\n\n']);
    expect(names(messages)).toEqual(['delta']);
  });

  it('id 와 retry 필드를 읽는다', () => {
    const messages = parseSSEChunks(['id: 42\nretry: 3000\nevent: delta\ndata: x\n\n']);
    expect(messages[0]).toMatchObject({ id: '42', retry: 3000, event: 'delta' });
  });

  it('중단 시점의 부분 data 를 확인할 수 있다', () => {
    const parser = new SSEParser();
    parser.push('event: delta\ndata: 진행중인');
    expect(parser.peekPartialData()).toBe('');
    parser.push(' 텍스트\n');
    expect(parser.peekPartialData()).toBe('진행중인 텍스트');
  });
});

/** 바이트 스트림을 임의 크기로 쪼개 주는 헬퍼. */
function byteStream(source: string, sizes: number[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(source);
  let offset = 0;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const size = sizes[index % sizes.length] ?? 1;
      index += 1;
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

describe('iterateSSE', () => {
  it('한국어(멀티바이트)가 바이트 경계에서 갈라져도 깨지지 않는다', async () => {
    const source =
      'event: delta\r\ndata: {"no":1,"text":"판별식이 음수이므로"}\r\n\r\n' +
      'event: delta\r\ndata: {"no":1,"text":"실근이 없다"}\r\n\r\n';

    const collected: SSEMessage[] = [];
    // 1바이트씩 -> 한글 3바이트가 반드시 갈라진다.
    for await (const message of iterateSSE(byteStream(source, [1]))) collected.push(message);

    expect(datas(collected)).toEqual([
      '{"no":1,"text":"판별식이 음수이므로"}',
      '{"no":1,"text":"실근이 없다"}',
    ]);
  });

  it('들쭉날쭉한 청크 크기에서도 모든 이벤트를 순서대로 준다', async () => {
    const parts: string[] = ['event: start\r\ndata: {"total":3}\r\n\r\n'];
    for (let no = 1; no <= 3; no += 1) {
      parts.push(`event: problem\r\ndata: {"no":${no},"status":"running"}\r\n\r\n`);
      parts.push(`event: delta\r\ndata: {"no":${no},"text":"풀이 ${no}"}\r\n\r\n`);
      parts.push(`event: done\r\ndata: {"no":${no},"solution":"끝"}\r\n\r\n`);
    }
    parts.push('event: end\r\ndata: {"total_usage":null}\r\n\r\n');

    const collected: SSEMessage[] = [];
    for await (const message of iterateSSE(byteStream(parts.join(''), [3, 1, 97, 11, 2]))) {
      collected.push(message);
    }

    expect(names(collected)).toEqual([
      'start',
      'problem',
      'delta',
      'done',
      'problem',
      'delta',
      'done',
      'problem',
      'delta',
      'done',
      'end',
    ]);
  });

  it('AbortSignal 로 중단하면 조용히 끝난다', async () => {
    const controller = new AbortController();
    const source = 'event: delta\r\ndata: 1\r\n\r\nevent: delta\r\ndata: 2\r\n\r\n';
    const collected: SSEMessage[] = [];
    for await (const message of iterateSSE(byteStream(source, [24]), controller.signal)) {
      collected.push(message);
      controller.abort();
    }
    expect(collected.length).toBeGreaterThanOrEqual(1);
  });
});
