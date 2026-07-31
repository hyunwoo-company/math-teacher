'use client';

import { estimatePerProblem, estimateTotal, findModel } from '@/lib/estimate';
import { formatKrw, formatUsd } from '@/lib/format';
import type { ModelInfo } from '@/types/api';

interface ApiCostNoticeProps {
  models: readonly ModelInfo[];
  modelId: string;
  usdKrw: number;
  /** 현재 열려 있는 시험지의 문항 수. 파일을 안 골랐으면 0. */
  problemCount: number;
  /** 구독을 아예 쓸 수 없는 환경인지(웹 배포). 문구가 달라진다. */
  subscriptionAvailable: boolean;
}

/**
 * API 키 모드로 호출될 때 뜨는 과금 안내.
 *
 * 금액은 **실측 기반 추정**이다(근거는 `lib/estimate.ts` 주석).
 * 정확한 청구액처럼 보이지 않도록 "추정" 을 문구에 반드시 남긴다.
 */
export function ApiCostNotice({
  models,
  modelId,
  usdKrw,
  problemCount,
  subscriptionAvailable,
}: ApiCostNoticeProps) {
  const model = findModel(models, modelId);
  const perProblem = estimatePerProblem(model, usdKrw);
  const total = estimateTotal(model, usdKrw, problemCount);

  return (
    <div
      role="note"
      className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] leading-relaxed text-amber-900"
    >
      <p className="font-semibold">API 키 모드 · 사용량만큼 요금이 청구됩니다</p>

      {perProblem ? (
        <p className="mt-0.5">
          <span className="font-medium">{model?.label ?? modelId}</span> 기준 문항당 약{' '}
          <span className="font-semibold tabular-nums">{formatKrw(perProblem.krw)}</span>
          <span className="tabular-nums"> ({formatUsd(perProblem.usd)})</span>
          {total ? (
            <>
              , 이 시험지 {problemCount}문항 전체 약{' '}
              <span className="font-semibold tabular-nums">{formatKrw(total.krw)}</span>
              <span className="tabular-nums"> ({formatUsd(total.usd)})</span>
            </>
          ) : null}
        </p>
      ) : (
        <p className="mt-0.5">선택한 모델의 단가 정보를 받지 못해 예상 금액을 계산할 수 없습니다.</p>
      )}

      {perProblem ? (
        <p className="mt-0.5 text-amber-800">
          실측 기반 추정이며 문항 난이도·모델·effort 에 따라 달라집니다.
        </p>
      ) : null}

      <p className="mt-1 border-t border-amber-200 pt-1 text-amber-800">
        {subscriptionAvailable
          ? '구독 모드로 바꾸면 API 요금 청구가 없습니다. (대신 구독 플랜의 사용량 한도를 소비합니다.)'
          : '구독 모드는 데스크톱 앱에서만 쓸 수 있어 이 환경에서는 API 키로만 호출됩니다.'}
      </p>
    </div>
  );
}
