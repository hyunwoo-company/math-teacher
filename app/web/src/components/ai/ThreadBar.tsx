'use client';

import { useMemo } from 'react';
import clsx from 'clsx';
import { useWorkspace } from '@/store/workspace';

interface ThreadChip {
  /** null = 시험지 전역 스레드. */
  problemNo: number | null;
  turns: number;
}

/**
 * 채팅 스레드(문항별 + 전역) 목록/전환/삭제 바.
 *
 * - 백엔드 스레드 목록(store.threads)에 전역 스레드와 현재 활성 스레드를 합쳐 칩으로 보여준다.
 * - 칩 클릭 → 그 스레드로 전환(store.openThread, 해당 히스토리 로드).
 * - 칩의 × → 그 스레드 삭제(store.deleteThread).
 * - 활성 스레드는 파란색으로 강조한다.
 */
export function ThreadBar() {
  const selectedFileId = useWorkspace((state) => state.selectedFileId);
  const threads = useWorkspace((state) => state.threads);
  const activeThreadNo = useWorkspace((state) => state.activeThreadNo);
  const openThread = useWorkspace((state) => state.openThread);
  const deleteThread = useWorkspace((state) => state.deleteThread);

  const chips = useMemo<ThreadChip[]>(() => {
    const result: ThreadChip[] = [];
    // 전역 스레드는 항상 첫 칩으로 노출한다(비어 있어도).
    const global = threads.find((thread) => thread.problem_no === null);
    result.push({ problemNo: null, turns: global?.turns ?? 0 });
    // 문항별 스레드는 번호 순.
    const perProblem = threads
      .filter((thread) => thread.problem_no != null)
      .sort((a, b) => (a.problem_no ?? 0) - (b.problem_no ?? 0));
    for (const thread of perProblem) {
      result.push({ problemNo: thread.problem_no, turns: thread.turns });
    }
    // 아직 목록에 없는 활성 스레드(막 연 문항)도 보이게 한다.
    if (activeThreadNo != null && !result.some((chip) => chip.problemNo === activeThreadNo)) {
      result.push({ problemNo: activeThreadNo, turns: 0 });
    }
    return result;
  }, [threads, activeThreadNo]);

  if (!selectedFileId) return null;

  return (
    <div className="border-b border-slate-100 bg-slate-50 px-3 py-1.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-[11px] font-medium text-slate-500">대화 스레드</span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {chips.map((chip) => {
            const active = activeThreadNo === chip.problemNo;
            const label = chip.problemNo == null ? '전체' : `${chip.problemNo}번`;
            return (
              <span
                key={chip.problemNo ?? 'global'}
                className={clsx(
                  'inline-flex shrink-0 items-center gap-1 rounded-full border py-0.5 pl-2 pr-1 text-[11px]',
                  active
                    ? 'border-blue-500 bg-blue-600 text-white'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-blue-400 hover:bg-blue-50',
                )}
              >
                <button
                  type="button"
                  onClick={() => void openThread(chip.problemNo)}
                  aria-pressed={active}
                  title={
                    chip.problemNo == null
                      ? '전체 대화(전역 스레드)로 전환'
                      : `${chip.problemNo}번 문제 대화로 전환`
                  }
                  className="inline-flex items-center gap-1"
                >
                  <span className="font-medium">{label}</span>
                  {chip.turns > 0 ? (
                    <span className={clsx('tabular-nums', active ? 'text-blue-100' : 'text-slate-400')}>
                      {chip.turns}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  onClick={() => void deleteThread(chip.problemNo)}
                  aria-label={`${label} 스레드 삭제`}
                  title={`${label} 스레드 삭제`}
                  className={clsx(
                    'inline-flex h-4 w-4 items-center justify-center rounded-full text-[12px] leading-none',
                    active ? 'text-blue-100 hover:bg-blue-500' : 'text-slate-400 hover:bg-slate-200',
                  )}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      </div>

      {/* 활성 스레드 안내(문항 스레드면 문제 이미지·기존 풀이가 함께 전달됨). */}
      <p className="mt-1 text-[11px] text-slate-500">
        {activeThreadNo != null
          ? `${activeThreadNo}번 문제 대화 · 문제 이미지와 기존 풀이가 함께 전달됩니다`
          : '전체 대화 · 문제를 클릭하면 그 문제 스레드가 열립니다'}
      </p>
    </div>
  );
}
