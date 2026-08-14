import { describe, expect, it } from 'vitest';
import { toStreamEvent } from '@/lib/stream-events';
import type { SSEMessage } from '@/lib/sse';

function message(event: string, data: unknown): SSEMessage {
  return { event, data: typeof data === 'string' ? data : JSON.stringify(data), id: null, retry: null };
}

describe('toStreamEvent', () => {
  it('start 이벤트를 매핑한다', () => {
    expect(toStreamEvent(message('start', { total: 22 }))).toEqual({ type: 'start', total: 22 });
  });

  it('problem 이벤트를 매핑한다', () => {
    expect(toStreamEvent(message('problem', { no: 3, status: 'running' }))).toEqual({
      type: 'problem',
      no: 3,
      status: 'running',
    });
  });

  it('delta 이벤트를 매핑한다', () => {
    expect(toStreamEvent(message('delta', { no: 3, text: '부분 텍스트' }))).toEqual({
      type: 'delta',
      no: 3,
      text: '부분 텍스트',
    });
  });

  it('done 이벤트의 usage/cost 를 뽑는다', () => {
    const event = toStreamEvent(
      message('done', {
        no: 1,
        solution: '풀이',
        usage: { input_tokens: 100, output_tokens: 50, unknown_field: 'x' },
        cost: {
          model: 'claude-opus-5',
          total_usd: 0.00175,
          total_krw: 2.45,
          usd_krw: 1400,
          tokens: { input: 100, output: 50, cache_write: 0, cache_read: 0, total: 150 },
        },
        truncated: false,
      }),
    );

    expect(event).toMatchObject({
      type: 'done',
      no: 1,
      solution: '풀이',
      truncated: false,
      usage: { input_tokens: 100, output_tokens: 50 },
      cost: { total_usd: 0.00175, total_krw: 2.45 },
    });
    // 계약에 없는 필드는 버린다.
    expect(event).not.toHaveProperty('usage.unknown_field');
  });

  it('구독 모드처럼 usage/cost 가 null 이면 null 로 유지한다', () => {
    expect(
      toStreamEvent(message('done', { no: 1, solution: 'x', usage: null, cost: null, truncated: false })),
    ).toMatchObject({ usage: null, cost: null });
  });

  it('error 이벤트를 매핑한다', () => {
    expect(
      toStreamEvent(message('error', { no: 5, error_code: 'refusal', message: '거부되었습니다.' })),
    ).toEqual({ type: 'error', no: 5, error_code: 'refusal', message: '거부되었습니다.' });
  });

  it('end 이벤트를 매핑한다', () => {
    expect(
      toStreamEvent(message('end', { total_usage: { input_tokens: 10 }, total_cost: null })),
    ).toMatchObject({ type: 'end', total_usage: { input_tokens: 10 }, total_cost: null });
  });

  it('판독 작업의 problem 이벤트는 경로(route)를 함께 넘긴다', () => {
    expect(toStreamEvent(message('problem', { no: 3, status: 'running', route: 'pua' }))).toEqual({
      type: 'problem',
      no: 3,
      status: 'running',
      route: 'pua',
    });
  });

  it('판독 작업의 done 이벤트는 전문·출처·이유를 넘긴다', () => {
    expect(
      toStreamEvent(
        message('done', {
          no: 3,
          source: 'pua',
          transcript: '\\(A = 3x^2\\)',
          note: null,
          usage: null,
          cost: null,
          truncated: false,
        }),
      ),
    ).toMatchObject({
      type: 'done',
      no: 3,
      // SSE 는 짧은 이름(`source`/`note`)을 쓴다 — REST 응답의
      // `transcript_source`/`transcript_note` 와 다르다.
      transcript: '\\(A = 3x^2\\)',
      source: 'pua',
      note: null,
    });
  });

  it('판독 불가는 전문이 null 이고 이유만 온다', () => {
    expect(
      toStreamEvent(
        message('done', {
          no: 5,
          source: null,
          transcript: null,
          note: '불가 - 좌표평면 그래프',
          usage: null,
          cost: null,
          truncated: false,
        }),
      ),
    ).toMatchObject({
      transcript: null,
      source: null,
      note: '불가 - 좌표평면 그래프',
    });
  });

  it('판독 필드가 없는 풀이 done 에는 그 키를 만들지 않는다', () => {
    // 있어야만 판독 작업의 이벤트다. 없는데 null 로 채우면 "전문이 지워졌다" 와
    // 구분할 수 없어 스토어가 멀쩡한 판독본을 비운다.
    const event = toStreamEvent(message('done', { no: 1, solution: '풀이', truncated: false }));
    expect(event).not.toHaveProperty('transcript');
    expect(event).not.toHaveProperty('note');
  });

  it('JSON 이 깨져도 던지지 않고 unknown 으로 넘긴다', () => {
    expect(toStreamEvent(message('delta', '{"no": '))).toEqual({
      type: 'unknown',
      event: 'delta',
      raw: '{"no": ',
    });
  });

  it('모르는 이벤트 이름은 unknown 으로 넘긴다', () => {
    expect(toStreamEvent(message('heartbeat', { t: 1 }))).toMatchObject({
      type: 'unknown',
      event: 'heartbeat',
    });
  });

  it('필드가 빠져도 기본값으로 채운다', () => {
    expect(toStreamEvent(message('delta', {}))).toEqual({ type: 'delta', no: null, text: '' });
    expect(toStreamEvent(message('error', {}))).toMatchObject({
      type: 'error',
      error_code: 'unknown',
    });
  });
});
