'use client';

import { formatInt, formatKrw, formatUsd } from '@/lib/format';
import { useWorkspace } from '@/store/workspace';
import { totalTokens } from '@/lib/format';

/**
 * 최하단 누적 사용량.
 *
 * 금액(USD/KRW)은 **API 키 모드로 호출한 분량에만** 존재한다. 구독 모드는
 * 백엔드가 `cost: null` 을 주므로 금액을 표시하지 않고, 대신 Max 구독 한도를
 * 소비했다는 사실을 밝힌다. 구독 호출을 "$0" 으로 적으면 공짜라는 오해를 준다.
 * 두 모드를 섞어 쓴 세션에서는 금액이 API 호출분만이라는 것을 명시한다.
 */
export function UsageFooter() {
  const totals = useWorkspace((state) => state.totals);
  const env = useWorkspace((state) => state.env);
  const provider = useWorkspace((state) => state.provider);

  const providerConfig = useWorkspace((state) => state.providerConfig);

  const tokens = totalTokens(totals.usage);
  const hasBilled = totals.billedCalls > 0;
  const hasSubscription = totals.subscriptionCalls > 0;

  // 현재 provider 의 과금 방식 안내(계약 3-C: agy=쿼터, apikey=종량, 구독=한도).
  const billing = providerConfig?.options.find((option) => option.id === provider)?.billing;
  const billingHint =
    billing === 'quota'
      ? '쿼터 사용 (추가 과금 없음)'
      : billing === 'usage'
        ? 'API 과금 모드'
        : billing === 'subscription'
          ? '구독 모드 · API 요금 청구 없음'
          : provider === 'apikey'
            ? 'API 과금 모드'
            : '구독 모드 · API 요금 청구 없음';

  // 아직 호출이 없으면, 지금 설정으로 호출하면 과금이 어떻게 되는지 미리 알린다.
  if (!hasBilled && !hasSubscription) {
    return (
      <footer className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
        <div className="flex items-center justify-between">
          <span>아직 사용량이 없습니다</span>
          <span className="text-slate-400">{billingHint}</span>
        </div>
      </footer>
    );
  }

  const callSummary = [
    hasBilled ? `API ${totals.billedCalls}회` : null,
    hasSubscription ? `구독 ${totals.subscriptionCalls}회` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <footer className="border-t border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-600">
      <div className="space-y-0.5">
        <div className="flex items-center justify-between">
          <span className="font-medium text-slate-700">누적 사용량</span>
          <span className="text-slate-400">이번 세션 · {callSummary}</span>
        </div>

        <div className="flex items-center gap-3 tabular-nums">
          <span>토큰 {formatInt(tokens)}</span>
          {hasBilled ? (
            <>
              <span>{formatUsd(totals.usd)}</span>
              <span className="font-medium text-slate-800">{formatKrw(totals.krw)}</span>
            </>
          ) : (
            <span className="text-slate-400">요금 청구 없음</span>
          )}
        </div>

        {hasSubscription ? (
          <p className="text-[10px] text-slate-500">
            {billing === 'quota'
              ? `무과금 호출 ${totals.subscriptionCalls}회. 쿼터(사용량 한도)를 소비하며 달러 청구는 없습니다.`
              : `구독/무과금 호출 ${totals.subscriptionCalls}회. API 요금 청구는 없지만 플랜 사용량 한도는 소비됩니다.`}
          </p>
        ) : null}

        {hasBilled && env ? (
          <p className="text-[10px] text-slate-400">
            금액은 API 키로 호출한 {totals.billedCalls}회분입니다. 환율 1달러 ={' '}
            {formatInt(env.usd_krw)}원 기준의 표시용 근사값입니다.
          </p>
        ) : null}
      </div>
    </footer>
  );
}
