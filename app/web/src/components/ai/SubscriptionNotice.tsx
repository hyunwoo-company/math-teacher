'use client';

import { useState } from 'react';
import { Spinner } from '@/components/ui/Feedback';
import { estimatePerProblem, findModel } from '@/lib/estimate';
import { formatKrw } from '@/lib/format';
import { CLAUDE_CODE_DOCS_URL, subscriptionGuidance } from '@/lib/subscription-status';
import { useWorkspace } from '@/store/workspace';
import type { EnvResponse } from '@/types/api';

interface SubscriptionNoticeProps {
  env: EnvResponse;
  /** 예상 비용 문구에 쓸 현재 선택 모델. */
  modelId: string;
}

/**
 * AI 를 호출할 수단이 하나도 없을 때 프롬프트 영역에 띄우는 안내.
 *
 * 온보딩과 중복되지 않게, 온보딩을 건너뛴 뒤에도 여기서 계속 보이게 한다.
 * 두 가지 길을 항상 같이 제시한다.
 *   1) Claude Code(터미널 CLI) 설치·로그인 -> 구독으로 추가 요금 없음
 *   2) API 키 입력 -> 즉시 사용 가능하지만 사용량만큼 과금
 */
export function SubscriptionNotice({ env, modelId }: SubscriptionNoticeProps) {
  const loadEnv = useWorkspace((state) => state.loadEnv);
  const saveApiKey = useWorkspace((state) => state.saveApiKey);

  const [rechecking, setRechecking] = useState(false);
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const guidance = subscriptionGuidance(env);
  if (!guidance) return null;

  const perProblem = estimatePerProblem(findModel(env.models, modelId), env.usd_krw);

  const recheck = async () => {
    setRechecking(true);
    await loadEnv();
    setRechecking(false);
  };

  const submitKey = async () => {
    if (key.trim() === '' || saving) return;
    setSaving(true);
    await saveApiKey(key.trim());
    setSaving(false);
    setKey('');
  };

  return (
    <div
      role="note"
      aria-label="AI 사용 준비 안내"
      className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-2 text-[11px] leading-relaxed text-amber-900"
    >
      <p className="font-semibold">{guidance.title}</p>

      <p className={expanded ? 'mt-1' : 'mt-1 line-clamp-2'}>{guidance.description}</p>
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="mt-0.5 text-[10px] text-amber-700 underline underline-offset-2"
      >
        {expanded ? '접기' : '자세히'}
      </button>

      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {guidance.recheckable ? (
          <button
            type="button"
            onClick={() => void recheck()}
            disabled={rechecking}
            className="inline-flex items-center gap-1.5 rounded border border-amber-400 bg-white px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
          >
            {rechecking ? <Spinner className="h-3 w-3" /> : null}
            다시 확인
          </button>
        ) : null}

        {guidance.showDocsLink ? (
          <a
            href={CLAUDE_CODE_DOCS_URL}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[11px] text-amber-800 underline underline-offset-2 hover:text-amber-950"
          >
            Claude Code 문서 열기
          </a>
        ) : null}
      </div>

      <div className="mt-2 border-t border-amber-200 pt-1.5">
        <p className="font-medium">지금 바로 쓰려면 API 키를 입력하세요</p>
        <p className="text-amber-800">
          사용량만큼 요금이 청구됩니다
          {perProblem ? (
            <>
              . 문항당 약{' '}
              <span className="font-semibold tabular-nums">{formatKrw(perProblem.krw)}</span> (실측
              기반 추정)
            </>
          ) : (
            '.'
          )}
        </p>
        <div className="mt-1 flex gap-1.5">
          <input
            type="password"
            aria-label="Anthropic API 키"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitKey();
            }}
            placeholder="sk-ant-..."
            className="min-w-0 flex-1 rounded border border-amber-300 bg-white px-1.5 py-1 font-mono text-[11px] text-slate-800 outline-none focus:border-amber-500"
          />
          <button
            type="button"
            onClick={() => void submitKey()}
            disabled={key.trim() === '' || saving}
            className="inline-flex items-center gap-1 rounded border border-amber-500 bg-amber-500 px-2 py-1 text-[11px] font-medium text-white hover:bg-amber-600 disabled:border-amber-200 disabled:bg-amber-200"
          >
            {saving ? <Spinner className="h-3 w-3" /> : null}
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
