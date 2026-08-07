'use client';

import { formatInt, totalTokens } from '@/lib/format';
import { useWorkspace } from '@/store/workspace';

/**
 * agy 쿼터 사용량 상태 바(status line 스타일).
 *
 * agy 는 쿼터 기반이라 금액(%)이 아니라 토큰 수로 표시한다.
 *  - 이번 세션: 스토어 totals 의 누적 토큰(현재 브라우저 세션).
 *  - 최근 7일: 신규 엔드포인트 `GET /api/usage/summary` 응답.
 * 요약이 아직 없으면(미배포/실패) 세션 값만 조용히 보여준다.
 */
export function UsageStatusBar() {
  const totals = useWorkspace((state) => state.totals);
  const usageSummary = useWorkspace((state) => state.usageSummary);

  const sessionTokens = totalTokens(totals.usage);
  const last7 = usageSummary?.windows.last_7_days ?? null;

  return (
    <div
      className="flex items-center gap-2 border-t border-slate-200 bg-white px-3 py-1 text-[11px] text-slate-500"
      title="agy 는 쿼터 기반이라 금액이 아니라 토큰 수로 표시합니다."
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
      />
      <span className="min-w-0 flex-1 truncate tabular-nums">
        <span className="text-slate-600">세션 {formatInt(sessionTokens)}</span>
        {last7 ? (
          <>
            <span className="mx-1 text-slate-300">·</span>
            <span className="text-slate-600">최근 7일 {formatInt(last7.tokens)}</span>
          </>
        ) : null}
        <span className="ml-1 text-slate-400">토큰</span>
      </span>
      <span className="shrink-0 text-slate-400">쿼터 기준</span>
    </div>
  );
}
