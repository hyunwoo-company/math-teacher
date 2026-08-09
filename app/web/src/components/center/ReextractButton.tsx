'use client';

import { useState } from 'react';
import clsx from 'clsx';
import { Spinner } from '@/components/ui/Feedback';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useWorkspace } from '@/store/workspace';

interface ReextractButtonProps {
  /** 시험지 파일 노드 id. */
  fileId: string;
  /** 현재 저장된 문항 수(0이면 "추출 실패" 상태라 버튼을 강조한다). */
  problemCount: number;
  className?: string;
}

/**
 * '문제 다시 추출' 버튼.
 *
 * 추출 규칙(extractor)을 고친 뒤 기존 업로드분에 반영할 때 쓴다. 예전에는
 * 파일을 지우고 다시 올려야 했다. 원본 PDF 는 그대로 두고 문항만 다시 뽑는다.
 * AI 를 호출하지 않으므로 비용·쿼터가 들지 않는다.
 *
 * 기존 풀이는 지워지므로(문항 번호가 달라질 수 있다) 항상 확인을 받는다.
 */
export function ReextractButton({ fileId, problemCount, className }: ReextractButtonProps) {
  const reextractFile = useWorkspace((state) => state.reextractFile);
  const reextracting = useWorkspace((state) => state.reextracting);
  const solutions = useWorkspace((state) => state.solutions);

  const [confirming, setConfirming] = useState(false);

  const busy = reextracting === fileId;
  const solvedCount = Object.values(solutions).filter((entry) => entry.status === 'done').length;
  // 문항이 0개면 추출에 실패한 상태다. 이때는 눈에 띄게 해서 바로 다시 시도하게 한다.
  const emphasize = problemCount === 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={busy || reextracting != null}
        title="원본 PDF 로 문항을 다시 추출합니다 (AI 호출 없음)"
        className={clsx(
          'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium disabled:opacity-50',
          emphasize
            ? 'border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50',
          className,
        )}
      >
        {busy ? (
          <Spinner className="h-3 w-3" />
        ) : (
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" strokeLinecap="round" />
            <path d="M13.5 2v3.5H10" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {busy ? '추출 중…' : '문제 다시 추출'}
      </button>

      <ConfirmDialog
        open={confirming}
        title="문제 다시 추출"
        confirmLabel="다시 추출"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          void reextractFile(fileId);
        }}
        message={
          <div className="space-y-1.5">
            <p>업로드된 원본 PDF 로 문항을 다시 추출합니다. AI 를 호출하지 않습니다.</p>
            {solvedCount > 0 ? (
              <p className="text-rose-700">
                저장된 <span className="font-semibold">풀이 {solvedCount}건이 삭제됩니다.</span>{' '}
                문항 번호가 달라질 수 있어 예전 풀이를 그대로 둘 수 없습니다.
              </p>
            ) : null}
            <p className="text-slate-500">
              오답노트에 담은 문항은 그대로 남습니다(담을 때 이미지를 복사해 둡니다).
            </p>
          </div>
        }
      />
    </>
  );
}
