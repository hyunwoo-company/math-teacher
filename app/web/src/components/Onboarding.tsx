'use client';

import { useState } from 'react';
import { useWorkspace } from '@/store/workspace';
import { Spinner } from '@/components/ui/Feedback';
import type { EnvResponse } from '@/types/api';

interface OnboardingProps {
  env: EnvResponse;
}

/**
 * AI 공급자가 하나도 준비되지 않았을 때의 안내 화면.
 * 구독 가능 여부는 `GET /api/env` 결과로만 판단한다(하드코딩 금지).
 */
export function Onboarding({ env }: OnboardingProps) {
  const saveApiKey = useWorkspace((state) => state.saveApiKey);
  const skipOnboarding = useWorkspace((state) => state.skipOnboarding);
  const loadEnv = useWorkspace((state) => state.loadEnv);

  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  const submit = async () => {
    if (key.trim() === '' || saving) return;
    setSaving(true);
    await saveApiKey(key.trim());
    setSaving(false);
    setKey('');
  };

  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-slate-100 p-6">
      <div className="w-full max-w-[560px] space-y-4">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">AI 공급자를 설정해 주세요</h1>
          <p className="mt-1 text-[13px] text-slate-600">
            문제 풀이를 생성하려면 Claude 구독 인증이나 API 키 중 하나가 필요합니다. 시험지 정리와
            문제 추출은 설정 없이도 바로 쓸 수 있습니다.
          </p>
        </div>

        {env.mode === 'desktop' ? (
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <h2 className="text-[13px] font-semibold text-slate-800">
              방법 1. Claude Code 구독 사용 (추가 과금 없음)
            </h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-slate-600">
              <li>Claude Code CLI 를 설치합니다.</li>
              <li>
                터미널에서 <code className="rounded bg-slate-100 px-1">claude</code> 를 실행해
                로그인합니다.
              </li>
              <li>아래 [다시 확인] 을 누르면 이 앱이 인증을 자동으로 찾습니다.</li>
            </ol>
            <button
              type="button"
              onClick={async () => {
                setRechecking(true);
                await loadEnv();
                setRechecking(false);
              }}
              className="mt-3 inline-flex items-center gap-2 rounded border border-slate-300 bg-white px-3 py-1.5 text-[13px] font-medium text-slate-700 hover:bg-slate-50"
            >
              {rechecking ? <Spinner className="h-3.5 w-3.5" /> : null}
              다시 확인
            </button>
          </section>
        ) : (
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-[13px] text-amber-900">
            <p className="font-semibold">웹에서는 구독 모드를 쓸 수 없습니다</p>
            <p className="mt-1">
              서버가 사용자 PC 의 Claude Code 인증에 접근할 수 없기 때문입니다. 구독으로 쓰시려면
              데스크톱 앱을 이용하시고, 웹에서는 아래에 API 키를 입력해 주세요.
            </p>
          </section>
        )}

        <section className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-[13px] font-semibold text-slate-800">
            방법 {env.mode === 'desktop' ? '2' : '1'}. Anthropic API 키 사용
          </h2>
          <p className="mt-1 text-[13px] text-slate-600">
            사용한 만큼 과금됩니다. 화면 오른쪽 아래에 누적 토큰과 예상 금액(원)이 표시됩니다.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              placeholder="sk-ant-..."
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5 font-mono text-[13px] outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={key.trim() === '' || saving}
              className="inline-flex items-center gap-2 rounded border border-blue-600 bg-blue-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-blue-700 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
            >
              {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
              저장
            </button>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            {env.mode === 'desktop'
              ? '데스크톱에서는 키가 이 PC 의 설정 파일에 평문으로 저장됩니다. 공용 PC 에서는 사용 후 삭제하세요.'
              : '웹에서는 키를 서버에 저장하지 않고, 요청할 때마다 이 브라우저에서 헤더로 전달합니다.'}
          </p>
        </section>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={skipOnboarding}
            className="text-[13px] text-slate-500 underline underline-offset-2 hover:text-slate-700"
          >
            일단 둘러보기 (AI 없이 시험지만 정리)
          </button>
          <span className="text-[11px] text-slate-400">
            현재 모드: {env.mode === 'desktop' ? '데스크톱' : '웹'}
          </span>
        </div>
      </div>
    </div>
  );
}
