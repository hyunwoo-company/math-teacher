'use client';

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { MathText } from '@/components/MathText';
import { plainPreview } from '@/lib/math-text';
import { ProblemCrop } from '@/components/center/ProblemCrop';
import { VariantPanel } from '@/components/center/VariantPanel';
import { ReextractButton } from '@/components/center/ReextractButton';
import { CopyButton } from '@/components/ui/CopyButton';
import { toPlainText } from '@/lib/to-plain-text';
import { EmptyState, InlineBadge, LoadingState } from '@/components/ui/Feedback';
import { costAmounts, formatDateTime, formatInt, formatKrw, formatUsd, totalTokens } from '@/lib/format';
import { useWorkspace, type SolutionEntry } from '@/store/workspace';
import type { Problem } from '@/types/api';

const EMPTY_PROBLEMS: Problem[] = [];

/** 중앙 [풀이] 탭: 문제별 아코디언. */
export function SolutionsTab() {
  const fileDetail = useWorkspace((state) => state.fileDetail);
  const solutions = useWorkspace((state) => state.solutions);
  const solutionsStatus = useWorkspace((state) => state.solutionsStatus);
  const selectedProblemNo = useWorkspace((state) => state.selectedProblemNo);
  const solve = useWorkspace((state) => state.solve);
  const usdKrw = useWorkspace((state) => state.env?.usd_krw ?? 1400);

  const focusProblem = useWorkspace((state) => state.focusProblem);
  const startSolve = useWorkspace((state) => state.startSolve);

  const [openSet, setOpenSet] = useState<Set<number>>(new Set());
  const [unsolvedOnly, setUnsolvedOnly] = useState(false);

  // fileDetail 이 없을 때 매 렌더마다 새 배열이 생기지 않도록 메모한다.
  const problems = useMemo(() => fileDetail?.problems ?? EMPTY_PROBLEMS, [fileDetail]);
  const fileId = fileDetail?.node.id ?? null;

  const solvedCount = useMemo(
    () => problems.filter((problem) => solutions[problem.no]?.status === 'done').length,
    [problems, solutions],
  );

  const visible = useMemo(
    () =>
      unsolvedOnly
        ? problems.filter((problem) => solutions[problem.no]?.status !== 'done')
        : problems,
    [problems, solutions, unsolvedOnly],
  );

  if (!fileId) {
    return <EmptyState title="파일을 먼저 선택하세요" />;
  }

  if (solutionsStatus === 'loading' && problems.length === 0) {
    return <LoadingState label="풀이를 불러오는 중입니다…" />;
  }

  if (problems.length === 0) {
    return (
      <EmptyState
        title="이 파일에서 문제를 찾지 못했습니다"
        description="업로드한 PDF가 시험지 형식이 아니거나 문제 번호를 인식하지 못했을 수 있습니다. 원본을 PDF 탭에서 확인해 보세요. 추출 규칙이 개선된 뒤라면 아래 버튼으로 다시 시도할 수 있습니다(파일을 다시 올릴 필요 없음)."
        icon="🔍"
        action={<ReextractButton fileId={fileId} problemCount={0} />}
      />
    );
  }

  const toggle = (no: number) => {
    setOpenSet((current) => {
      const next = new Set(current);
      if (next.has(no)) next.delete(no);
      else next.add(no);
      return next;
    });
    focusProblem(no);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-[12px] text-slate-600">
        <span>
          풀이 완료 <span className="font-semibold text-slate-800">{solvedCount}</span> / {problems.length}
        </span>
        {solve.running ? (
          <span className="text-blue-700">
            풀이 중… {solve.doneCount}/{solve.total}
            {solve.currentNo != null ? ` (현재 ${solve.currentNo}번)` : ''}
          </span>
        ) : null}
        <label className="ml-auto flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={unsolvedOnly}
            onChange={(event) => setUnsolvedOnly(event.target.checked)}
            className="h-3.5 w-3.5"
          />
          미풀이만 보기
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <EmptyState
            title="모든 문제의 풀이가 준비되었습니다"
            description="체크를 해제하면 전체 목록을 볼 수 있습니다."
            icon="✅"
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((problem) => (
              <SolutionRow
                key={problem.no}
                fileId={fileId}
                problem={problem}
                entry={solutions[problem.no]}
                open={openSet.has(problem.no)}
                selected={selectedProblemNo === problem.no}
                usdKrw={usdKrw}
                onToggle={() => toggle(problem.no)}
                onSolveOne={() => void startSolve([problem.no])}
                onResolveOne={() => void startSolve([problem.no], { force: true })}
                disabled={solve.running}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

interface SolutionRowProps {
  fileId: string;
  problem: Problem;
  entry: SolutionEntry | undefined;
  open: boolean;
  selected: boolean;
  usdKrw: number;
  onToggle: () => void;
  onSolveOne: () => void;
  onResolveOne: () => void;
  disabled: boolean;
}

function SolutionRow({
  fileId,
  problem,
  entry,
  open,
  selected,
  usdKrw,
  onToggle,
  onSolveOne,
  onResolveOne,
  disabled,
}: SolutionRowProps) {
  const status = entry?.status ?? (problem.has_solution ? 'done' : 'empty');
  const streaming = status === 'running';
  const body = streaming ? (entry?.streamingText ?? '') : (entry?.text ?? '');
  const { usd, krw } = costAmounts(entry?.cost, usdKrw);
  const tokens = totalTokens(entry?.usage);

  return (
    <li className={clsx(selected && 'bg-blue-50/40')}>
      <div className="flex w-full items-start gap-3 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-label={`${problem.no}번 문제 풀이 ${open ? '접기' : '펼치기'}`}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <ProblemCrop fileId={fileId} no={problem.no} className="h-16 w-12 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-slate-800">{problem.no}번</span>
              <span className="text-[11px] text-slate-400">{problem.page}쪽</span>
              <StatusBadge status={status} truncated={entry?.truncated ?? false} />
            </span>
            <span className="mt-1 block truncate text-[12px] text-slate-500">
              {status === 'done'
                ? plainPreview(entry?.text ?? '')
                : status === 'running'
                  ? '생성 중…'
                  : status === 'error'
                    ? (entry?.error ?? '오류')
                    : '아직 풀이가 없습니다'}
            </span>
          </span>
          <span aria-hidden className="mt-1 shrink-0 text-[11px] text-slate-400">
            {open ? '▲' : '▼'}
          </span>
        </button>
      </div>

      {open ? (
        <div className="px-3 pb-3">
          <div className="rounded border border-slate-200 bg-white p-3">
            {body ? (
              <MathText
                className={clsx(
                  'text-[13px] leading-relaxed text-slate-800',
                  streaming && 'streaming-caret',
                )}
              >
                {body}
              </MathText>
            ) : status === 'error' ? (
              <p className="text-[13px] text-rose-700">{entry?.error}</p>
            ) : (
              <div className="flex flex-col items-start gap-2">
                <p className="text-[13px] text-slate-500">아직 풀이가 없습니다.</p>
                <button
                  type="button"
                  onClick={onSolveOne}
                  disabled={disabled}
                  className="rounded border border-blue-600 bg-blue-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  이 문제만 풀기
                </button>
              </div>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
            {/*
              과금 여부는 cost 로만 판단한다. 구독 모드는 백엔드가 usage 는 실제 값,
              cost 는 null 로 주므로 `usage || cost` 로 갈라내면 금액이 "- / -" 로 찍힌다.
            */}
            {entry?.cost ? (
              <>
                <span>토큰 {formatInt(tokens)}</span>
                <span>
                  {formatUsd(usd)} / {formatKrw(krw)}
                </span>
              </>
            ) : entry?.usage ? (
              <>
                <span>토큰 {formatInt(tokens)}</span>
                <span>구독 사용 · 요금 청구 없음</span>
              </>
            ) : status === 'done' ? (
              <span>구독 사용 · 요금 청구 없음</span>
            ) : null}
            {entry?.createdAt ? <span>{formatDateTime(entry.createdAt)}</span> : null}
            {status === 'done' ? (
              <div className="ml-auto flex items-center gap-2">
                {/* 두 버튼 다 용도가 이름에 있다: AI 대화용=마크다운 원문, 한글·워드용=유니코드 평문. */}
                {entry?.text ? (
                  <>
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
                  </>
                ) : null}
                <button
                  type="button"
                  onClick={onResolveOne}
                  disabled={disabled}
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  다시 풀기
                </button>
              </div>
            ) : null}
          </div>

          <VariantPanel fileId={fileId} no={problem.no} />
        </div>
      ) : null}
    </li>
  );
}

function StatusBadge({ status, truncated }: { status: SolutionEntry['status']; truncated: boolean }) {
  if (status === 'done') {
    return (
      <>
        <InlineBadge tone="green">풀이 완료</InlineBadge>
        {truncated ? <InlineBadge tone="amber">길이 제한으로 잘림</InlineBadge> : null}
      </>
    );
  }
  if (status === 'running') return <InlineBadge tone="blue">생성 중</InlineBadge>;
  if (status === 'error') return <InlineBadge tone="rose">실패</InlineBadge>;
  return <InlineBadge>미풀이</InlineBadge>;
}

