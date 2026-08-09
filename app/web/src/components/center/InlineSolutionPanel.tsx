'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { MathText } from '@/components/MathText';
import { CopyButton } from '@/components/ui/CopyButton';
import { Spinner } from '@/components/ui/Feedback';
import { toPlainText } from '@/lib/to-plain-text';
import { useWorkspace, type SolutionEntry } from '@/store/workspace';

interface InlineSolutionPanelProps {
  /** 원본 시험지 file_id. */
  fileId: string;
  /** 원본 시험지 문항 번호. */
  no: number;
  /** 외부 사유로 풀이를 막을 때(선택). */
  disabled?: boolean;
  className?: string;
}

/**
 * 접이식 "풀이 보기" 패널. 오답노트 항목에서 그 문항(file_id + problem_no)의
 * 풀이를 노트 화면 안에서 바로 확인한다.
 *
 * 캐시 UX(agy 사용량 낭비 방지):
 * - 접힘이 기본. "풀이 보기" 를 눌러야 열린다. 열린 뒤 헤더를 다시 누르면 접힌다(토글).
 * - 열리면 저장 풀이만 조회한다(자동 풀이 없음): 저장분이 있으면 그대로 표시,
 *   없으면 "풀이 만들기" 버튼을 보여준다.
 * - "풀이 만들기" 로만 1회 풀이하고 캐시한다. 이후엔 재호출 없이 캐시를 보여준다.
 * - 결과는 스토어 `problemSolutions[`${fileId}::${no}`]` 에 캐시되어 재열람 시 즉시 표시된다.
 *   접었다 다시 열어도 재호출 없이 캐시를 즉시 보여준다.
 */
export function InlineSolutionPanel({ fileId, no, disabled = false, className }: InlineSolutionPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={clsx('mt-3 rounded border border-slate-200 bg-slate-50/70 p-2.5', className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        <span aria-hidden>📖</span> {open ? '풀이 닫기' : '풀이 보기'}
      </button>
      {open ? (
        <div className="mt-2.5">
          <InlineSolutionBody fileId={fileId} no={no} disabled={disabled} />
        </div>
      ) : null}
    </div>
  );
}

function InlineSolutionBody({ fileId, no, disabled }: { fileId: string; no: number; disabled: boolean }) {
  const key = `${fileId}::${no}`;
  const entry = useWorkspace((state) => state.problemSolutions[key]);
  const loadProblemSolution = useWorkspace((state) => state.loadProblemSolution);
  const solveProblem = useWorkspace((state) => state.solveProblem);
  const [loading, setLoading] = useState(false);

  // 열릴 때 저장 풀이만 조회한다(풀이는 하지 않음). 이미 캐시가 있으면 스토어가 no-op.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void loadProblemSolution(fileId, no).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fileId, no, loadProblemSolution]);

  const status = entry?.status ?? 'empty';
  const streaming = status === 'running';
  const body = streaming ? (entry?.streamingText ?? '') : (entry?.text ?? '');

  return (
    <>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-semibold text-slate-700">풀이</span>
        {status === 'done' ? (
          <p className="text-[11px] text-slate-400">저장된 풀이입니다.</p>
        ) : (
          <p className="text-[11px] text-slate-400">저장된 풀이가 없으면 만들 수 있습니다.</p>
        )}
      </div>

      <div className="rounded border border-slate-200 bg-white p-2.5">
        <SolutionContent
          entry={entry}
          loading={loading}
          streaming={streaming}
          body={body}
          disabled={disabled}
          onSolve={() => void solveProblem(fileId, no)}
          onResolve={() => void solveProblem(fileId, no, { force: true })}
        />
      </div>
    </>
  );
}

function SolutionContent({
  entry,
  loading,
  streaming,
  body,
  disabled,
  onSolve,
  onResolve,
}: {
  entry: SolutionEntry | undefined;
  loading: boolean;
  streaming: boolean;
  body: string;
  disabled: boolean;
  onSolve: () => void;
  onResolve: () => void;
}) {
  const status = entry?.status ?? 'empty';

  // 생성 중: 스트리밍 본문을 캐럿과 함께 보여준다.
  if (streaming) {
    return (
      <>
        <div className="mb-1.5 flex min-h-[20px] items-center gap-2">
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <Spinner className="h-3 w-3" /> 생성 중…
          </span>
        </div>
        {body ? (
          <MathText className="text-[13px] leading-relaxed text-slate-800 streaming-caret">
            {body}
          </MathText>
        ) : (
          <p className="text-[12px] text-slate-400">풀이를 만들고 있습니다…</p>
        )}
      </>
    );
  }

  // 저장/생성 완료: 본문 + 복사 2종 + 다시 풀기.
  if (status === 'done' && entry?.text) {
    return (
      <>
        <div className="mb-1.5 flex min-h-[20px] items-center">
          <div className="ml-auto flex items-center gap-1.5">
            {/* 두 버튼 다 용도가 이름에 있다: AI 대화용=마크다운 원문, 한글·워드용=유니코드 평문. */}
            <CopyButton
              text={entry.text}
              label="복사(AI 대화용)"
              title="마크다운·LaTeX 원문 그대로 복사 (다른 AI 에 붙여넣을 때)"
            />
            <CopyButton
              text={toPlainText(entry.text)}
              label="복사(한글·워드용)"
              title="한글·워드에 붙여넣을 수 있는 텍스트로 복사"
            />
            <button
              type="button"
              onClick={onResolve}
              disabled={disabled}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              다시 풀기
            </button>
          </div>
        </div>
        <MathText className="text-[13px] leading-relaxed text-slate-800">{entry.text}</MathText>
      </>
    );
  }

  // 저장 풀이 조회 중.
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
        <Spinner className="h-3 w-3" /> 저장된 풀이를 불러오는 중…
      </span>
    );
  }

  // 실패: 안내 + 다시 시도(풀이 생성).
  if (status === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] text-rose-700">{entry?.error ?? '풀이를 준비하지 못했습니다.'}</p>
        <button
          type="button"
          onClick={onResolve}
          disabled={disabled}
          className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          풀이 만들기
        </button>
      </div>
    );
  }

  // 저장 풀이 없음: "풀이 만들기" 로만 1회 풀이한다(자동 실행 금지).
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-[12px] text-slate-500">아직 저장된 풀이가 없습니다.</p>
      <button
        type="button"
        onClick={onSolve}
        disabled={disabled}
        className="rounded border border-blue-600 bg-blue-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        풀이 만들기
      </button>
    </div>
  );
}
