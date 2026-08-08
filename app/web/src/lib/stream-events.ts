/**
 * SSE 메시지(문자열)를 타입 있는 이벤트로 변환한다.
 * 서버 필드가 빠지거나 JSON 이 깨져도 던지지 않고 'unknown' 으로 흘린다.
 */

import type { SSEMessage } from '@/lib/sse';
import type { StreamEvent, Usage, Cost } from '@/types/api';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

function readUsage(source: Record<string, unknown>, key: string): Usage | null {
  const record = asRecord(source[key]);
  if (!record) return null;
  const usage: Usage = {};
  for (const field of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const) {
    const value = record[field];
    if (typeof value === 'number' && Number.isFinite(value)) usage[field] = value;
  }
  return usage;
}

function readCost(source: Record<string, unknown>, key: string): Cost | null {
  const record = asRecord(source[key]);
  if (!record) return null;
  // pricing.py 의 반환 구조 중 UI 가 쓰는 필드만 뽑는다.
  const cost: Cost = {};
  const model = record['model'];
  if (typeof model === 'string') cost.model = model;
  const resolved = record['resolved_model'];
  if (typeof resolved === 'string') cost.resolved_model = resolved;
  const totalUsd = record['total_usd'];
  if (typeof totalUsd === 'number') cost.total_usd = totalUsd;
  const totalKrw = record['total_krw'];
  if (typeof totalKrw === 'number') cost.total_krw = totalKrw;
  const usdKrw = record['usd_krw'];
  if (typeof usdKrw === 'number') cost.usd_krw = usdKrw;
  const tokens = asRecord(record['tokens']);
  if (tokens) {
    cost.tokens = {
      input: readNumber(tokens, 'input') ?? 0,
      output: readNumber(tokens, 'output') ?? 0,
      cache_write: readNumber(tokens, 'cache_write') ?? 0,
      cache_read: readNumber(tokens, 'cache_read') ?? 0,
      total: readNumber(tokens, 'total') ?? 0,
    };
  }
  return cost;
}

/** SSE 메시지 -> StreamEvent. */
export function toStreamEvent(message: SSEMessage): StreamEvent {
  const unknown: StreamEvent = { type: 'unknown', event: message.event, raw: message.data };

  let parsed: unknown;
  try {
    parsed = message.data === '' ? {} : JSON.parse(message.data);
  } catch {
    return unknown;
  }
  const data = asRecord(parsed);
  if (!data) return unknown;

  switch (message.event) {
    case 'start':
      return { type: 'start', total: readNumber(data, 'total') ?? 0 };
    case 'problem':
      return {
        type: 'problem',
        no: readNumber(data, 'no') ?? 0,
        status: readString(data, 'status') ?? 'running',
      };
    case 'delta':
      return {
        type: 'delta',
        no: readNumber(data, 'no'),
        text: readString(data, 'text') ?? '',
      };
    case 'done': {
      const truncatedBefore = readNumber(data, 'truncated_before');
      return {
        type: 'done',
        no: readNumber(data, 'no'),
        // 파일 채팅/풀이는 `solution`, 전역 대화 채팅은 `content` 로 본문을 준다.
        solution: readString(data, 'solution') ?? readString(data, 'content') ?? '',
        usage: readUsage(data, 'usage'),
        cost: readCost(data, 'cost'),
        truncated: data['truncated'] === true,
        history_truncated: data['history_truncated'] === true,
        truncated_before: truncatedBefore ?? 0,
      };
    }
    case 'error':
      return {
        type: 'error',
        no: readNumber(data, 'no'),
        error_code: readString(data, 'error_code') ?? 'unknown',
        message: readString(data, 'message') ?? '알 수 없는 오류가 발생했습니다.',
      };
    case 'end':
      return {
        type: 'end',
        total_usage: readUsage(data, 'total_usage'),
        total_cost: readCost(data, 'total_cost'),
      };
    default:
      return unknown;
  }
}
