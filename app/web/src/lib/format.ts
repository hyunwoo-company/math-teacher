/**
 * 한국 사용자 기준 표시 형식 유틸.
 * 날짜는 `2026. 7. 31.`, 통화는 원(₩) 병기.
 */

import type { Cost, Usage } from '@/types/api';

const dateFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('ko-KR', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const integerFormatter = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

/** ISO 문자열 -> `2026. 7. 31.` */
export function formatDate(iso: string | null | undefined): string {
  const date = toDate(iso);
  if (!date) return '-';
  return dateFormatter.format(date);
}

/** ISO 문자열 -> `2026. 7. 31. 오후 07:41` */
export function formatDateTime(iso: string | null | undefined): string {
  const date = toDate(iso);
  if (!date) return '-';
  return dateTimeFormatter.format(date);
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 토큰 수 등 정수 -> `12,345` */
export function formatInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  return integerFormatter.format(Math.round(value));
}

/**
 * USD 표시. 소액이 많으므로 자릿수를 값 크기에 맞춘다.
 * `$0.0042` / `$1.23`
 */
export function formatUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (value === 0) return '$0';
  const digits = Math.abs(value) < 0.01 ? 4 : Math.abs(value) < 1 ? 3 : 2;
  return `$${value.toFixed(digits)}`;
}

/**
 * 원화 표시. 1원 미만은 소수점 2자리까지 보여준다(문제 1개 비용이 매우 작을 수 있다).
 * `₩1,234` / `₩0.58`
 */
export function formatKrw(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-';
  if (value === 0) return '₩0';
  if (Math.abs(value) < 1) return `₩${value.toFixed(2)}`;
  if (Math.abs(value) < 100) return `₩${value.toFixed(1)}`;
  return `₩${integerFormatter.format(Math.round(value))}`;
}

/** 파일 크기 -> `1.2MB` */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** usage 의 총 토큰 수. 필드가 없으면 있는 것만 더한다. */
export function totalTokens(usage: Usage | null | undefined): number {
  if (!usage) return 0;
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

/** 두 usage 를 합친다. 둘 다 null 이면 null. */
export function mergeUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0),
    output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
    cache_creation_input_tokens:
      (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
  };
}

/**
 * cost 의 USD/KRW 를 뽑는다.
 * 백엔드가 `total_krw` 를 안 주면 `usdKrw` 환율로 계산한다(표시용).
 */
export function costAmounts(
  cost: Cost | null | undefined,
  usdKrw: number,
): { usd: number | null; krw: number | null } {
  if (!cost) return { usd: null, krw: null };
  const usd = typeof cost.total_usd === 'number' ? cost.total_usd : null;
  const krw =
    typeof cost.total_krw === 'number'
      ? cost.total_krw
      : usd != null
        ? usd * (typeof cost.usd_krw === 'number' ? cost.usd_krw : usdKrw)
        : null;
  return { usd, krw };
}

/** effort 값의 한국어 라벨. */
export function effortLabel(effort: string): string {
  switch (effort) {
    case 'low':
      return '낮음';
    case 'medium':
      return '보통';
    case 'high':
      return '높음';
    case 'xhigh':
      return '매우 높음';
    case 'max':
      return '최대';
    default:
      return effort;
  }
}

/** provider 값의 한국어 라벨. */
export function providerLabel(provider: string): string {
  switch (provider) {
    case 'auto':
      return '자동';
    case 'subscription':
      return '구독';
    case 'apikey':
      return 'API 키';
    default:
      return provider;
  }
}
