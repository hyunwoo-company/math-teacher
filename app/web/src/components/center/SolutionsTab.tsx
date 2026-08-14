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
import { EmptyState, InlineBadge, LoadingState, Spinner } from '@/components/ui/Feedback';
import { costAmounts, formatDateTime, formatInt, formatKrw, formatUsd, totalTokens } from '@/lib/format';
import {
  VARIANT_PICK_KINDS,
  VARIANT_PICK_LABEL,
  allPicksRunning,
  hasRunningVariant,
  runningPickCount,
  variantProgressOf,
  type VariantProgress,
} from '@/lib/variant';
import { useWorkspace, type SolutionEntry } from '@/store/workspace';
import type { Problem } from '@/types/api';

const EMPTY_PROBLEMS: Problem[] = [];

/** 문항 행의 체크박스가 무엇을 고르는 중인지. 두 모드는 동시에 켜지지 않는다. */
type PickMode = 'none' | 'note' | 'variant';

/** 중앙 [풀이] 탭: 문제별 아코디언. */
export function SolutionsTab() {
  const fileDetail = useWorkspace((state) => state.fileDetail);
  const jobs = useWorkspace((state) => state.jobs);
  const cancelingJobIds = useWorkspace((state) => state.cancelingJobIds);
  const cancelJob = useWorkspace((state) => state.cancelJob);
  const picking = useWorkspace((state) => state.notePicking);
  const notePicked = useWorkspace((state) => state.notePicked);
  const toggleNotePick = useWorkspace((state) => state.toggleNotePick);
  const variantPicking = useWorkspace((state) => state.variantPicking);
  const variantPicked = useWorkspace((state) => state.variantPicked);
  const variantKind = useWorkspace((state) => state.variantKind);
  const startVariantPicking = useWorkspace((state) => state.startVariantPicking);
  const stopVariantPicking = useWorkspace((state) => state.stopVariantPicking);
  const toggleVariantPick = useWorkspace((state) => state.toggleVariantPick);
  const setVariantPicked = useWorkspace((state) => state.setVariantPicked);
  const setVariantKind = useWorkspace((state) => state.setVariantKind);
  const startVariantBatch = useWorkspace((state) => state.startVariantBatch);
  const variants = useWorkspace((state) => state.variants);
  const solutions = useWorkspace((state) => state.solutions);
  const solutionsStatus = useWorkspace((state) => state.solutionsStatus);
  const selectedProblemNo = useWorkspace((state) => state.selectedProblemNo);
  const solve = useWorkspace((state) => state.solve);
  const usdKrw = useWorkspace((state) => state.env?.usd_krw ?? 1400);

  const focusProblem = useWorkspace((state) => state.focusProblem);
  const startSolve = useWorkspace((state) => state.startSolve);

  const [openSet, setOpenSet] = useState<Set<number>>(new Set());
  const [unsolvedOnly, setUnsolvedOnly] = useState(false);
  /** 일괄 생성에서 이미 만든 조합도 다시 만들지(기본은 건너뛰기). */
  const [variantForce, setVariantForce] = useState(false);

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

  /**
   * 변형 진행 상황. 문항 안 패널과 **같은 자리**(variants 의 streaming)를 보므로
   * 아래가 "생성 중…" 이면 위에도 반드시 보인다. 따로 집계 상태를 두지 않는다.
   */
  const variantProgress = useMemo(
    () => (fileId ? variantProgressOf({ variants, fileId, jobs }) : null),
    [fileId, variants, jobs],
  );
  /** 고른 문항 중 지금 고른 유형으로 이미 생성 중인 문항 수. */
  const runningPicks = useMemo(
    () => (fileId ? runningPickCount(variants, fileId, variantPicked, variantKind) : 0),
    [fileId, variants, variantPicked, variantKind],
  );
  /** 고른 문항 전부가 지금 고른 유형으로 생성 중 = 다시 걸 게 없다. */
  const pickedAllRunning =
    fileId != null && allPicksRunning(variants, fileId, variantPicked, variantKind);

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

  // 두 모드는 상호 배타라 체크박스 하나가 언제나 한 가지 뜻만 갖는다.
  const pickMode: PickMode = variantPicking ? 'variant' : picking ? 'note' : 'none';
  const pickedSet = new Set(pickMode === 'variant' ? variantPicked : notePicked);
  // 이 시험지에서 진행 중인 풀이 작업(문항 행의 중단 버튼이 이걸 취소한다).
  const runningJob =
    jobs.find(
      (job) =>
        job.node_id === fileId &&
        job.kind === 'solve' &&
        (job.status === 'running' || job.status === 'queued'),
    ) ?? null;

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
        {/* 아래 패널이 "생성 중…" 이면 여기도 반드시 보인다(같은 자리를 본다). */}
        {variantProgress ? (
          <VariantProgressNotice
            progress={variantProgress}
            cancelingJobIds={cancelingJobIds}
            onCancel={(jobId) => void cancelJob(jobId)}
          />
        ) : null}
        <button
          type="button"
          onClick={() => {
            if (variantPicking) {
              stopVariantPicking();
              return;
            }
            // 모드는 문항 선택을 매번 버리고 시작한다(startVariantPicking).
            // 훨씬 비싼 force 만 남으면 규칙이 어긋난다 — 20문항 × 전체를
            // 모르고 다시 걸면 60건이 통째로 재생성된다.
            setVariantForce(false);
            startVariantPicking();
          }}
          aria-pressed={variantPicking}
          title={
            variantProgress
              ? '변형을 만드는 중입니다. 문항을 골라 다른 유형을 이어서 걸 수 있습니다'
              : '문항을 여러 개 골라 변형 문제를 한 번에 만듭니다'
          }
          className={clsx(
            'ml-auto inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium',
            variantPicking
              ? 'border-violet-600 bg-violet-600 text-white hover:bg-violet-700'
              : 'border-violet-300 bg-white text-violet-700 hover:bg-violet-50',
          )}
        >
          변형 만들기
          {/* 진행 중임을 버튼에서도 알린다(문항 패널 탭의 점과 같은 표시). */}
          {variantProgress ? (
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
          ) : null}
        </button>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={unsolvedOnly}
            onChange={(event) => setUnsolvedOnly(event.target.checked)}
            className="h-3.5 w-3.5"
          />
          미풀이만 보기
        </label>
      </div>

      {variantPicking ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-violet-200 bg-violet-50 px-3 py-1.5 text-[12px] text-slate-700">
          <span className="font-medium text-violet-900">변형 유형</span>
          <div className="flex items-center gap-1">
            {VARIANT_PICK_KINDS.map((kind) => {
              // 고른 문항이 **전부** 그 유형으로 생성 중일 때만 막는다. 일부만
              // 진행 중이면 나머지는 걸 수 있어야 한다(겹치는 조합은 서버가 건너뛴다).
              const busy = allPicksRunning(variants, fileId, variantPicked, kind);
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setVariantKind(kind)}
                  aria-pressed={variantKind === kind}
                  disabled={busy}
                  title={
                    busy
                      ? `이미 생성 중입니다 — 고른 ${variantPicked.length}개 문항이 모두 ${VARIANT_PICK_LABEL[kind]} 변형을 만들고 있습니다`
                      : undefined
                  }
                  className={clsx(
                    'rounded border px-2 py-0.5 text-[11px] disabled:cursor-not-allowed disabled:opacity-50',
                    variantKind === kind
                      ? 'border-violet-600 bg-violet-600 text-white'
                      : 'border-violet-300 bg-white text-violet-700 hover:bg-violet-100',
                  )}
                >
                  {VARIANT_PICK_LABEL[kind]}
                </button>
              );
            })}
          </div>
          <span className="text-violet-900">{variantPicked.length}개 문항 선택됨</span>
          <button
            type="button"
            onClick={() => setVariantPicked(visible.map((problem) => problem.no))}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
          >
            전체 선택
          </button>
          <button
            type="button"
            onClick={() => setVariantPicked([])}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
          >
            선택 해제
          </button>
          <div className="ml-auto flex items-center gap-2">
            {/*
              이미 만든 조합은 서버가 건너뛰고, 전부 건너뛰면 400 으로 거절한다.
              그때 여기서 빠져나갈 수단이 없으면 사용자가 막힌다.
            */}
            <label
              className="flex items-center gap-1.5 text-[11px] text-violet-900"
              title="이미 만들어 둔 변형도 새로 만듭니다(그만큼 사용량을 씁니다)"
            >
              <input
                type="checkbox"
                checked={variantForce}
                onChange={(event) => setVariantForce(event.target.checked)}
                className="h-3.5 w-3.5 accent-violet-600"
              />
              이미 만든 것도 다시 생성
            </label>
            {/*
              일부만 진행 중이면 막지 않는다. 다만 몇 개가 이미 돌고 있는지는
              밝혀야 한다 — 안 그러면 "왜 요청한 수보다 적게 만들어졌지" 가 된다.
            */}
            {runningPicks > 0 && !pickedAllRunning ? (
              <span className="text-[11px] text-violet-700">{runningPicks}개는 이미 생성 중</span>
            ) : null}
            <button
              type="button"
              onClick={() => void startVariantBatch({ force: variantForce })}
              disabled={variantPicked.length === 0 || pickedAllRunning}
              title={
                variantPicked.length === 0
                  ? '변형을 만들 문항을 먼저 고르세요'
                  : pickedAllRunning
                    ? `이미 생성 중입니다 — 고른 문항이 모두 ${VARIANT_PICK_LABEL[variantKind]} 변형을 만들고 있습니다`
                    : undefined
              }
              className="rounded border border-violet-600 bg-violet-600 px-2.5 py-0.5 text-[11px] font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {variantPicked.length}개 문항 변형 생성
            </button>
            <button
              type="button"
              onClick={() => stopVariantPicking()}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-50"
            >
              취소
            </button>
          </div>
        </div>
      ) : null}

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
                disabled={solutions[problem.no]?.status === 'running'}
                onCancel={
                  runningJob && solutions[problem.no]?.status === 'running'
                    ? () => void cancelJob(runningJob.id)
                    : undefined
                }
                canceling={runningJob != null && cancelingJobIds.includes(runningJob.id)}
                cancelLabel={
                  runningJob && runningJob.total > 1 ? '전체 풀이 중단' : '풀이 중단'
                }
                cancelTitle={
                  runningJob && runningJob.total > 1
                    ? `이 시험지의 풀이 작업(${runningJob.total}문항) 전체가 중단됩니다`
                    : '이 문제 풀이를 중단합니다'
                }
                pickMode={pickMode}
                variantRunning={hasRunningVariant(variants, fileId, problem.no)}
                picked={pickedSet.has(problem.no)}
                onTogglePick={() =>
                  pickMode === 'variant'
                    ? toggleVariantPick(problem.no)
                    : toggleNotePick(problem.no)
                }
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
  /** 진행 중 작업을 멈추는 콜백. 진행 중이 아니면 없다. */
  onCancel?: () => void;
  /** 중단 요청을 보내고 아직 멈추지 않았는지. */
  canceling: boolean;
  /** 중단 버튼 문구(단일 문항인지 전체 풀이인지에 따라 다르다). */
  cancelLabel: string;
  cancelTitle: string;
  /** 지금 체크박스가 무엇을 고르는 중인지('none' 이면 체크박스를 숨긴다). */
  pickMode: PickMode;
  /** 이 문항의 변형이 유형 하나라도 생성 중인지(변형 모드에서 배지로 알린다). */
  variantRunning: boolean;
  /** 이 문항이 고른 대상인지. */
  picked: boolean;
  onTogglePick: () => void;
}

/**
 * 상단 변형 진행 표시 + [중단].
 *
 * 중단 관례는 풀이 쪽과 같다: 요청을 보내면 버튼이 "중단하는 중…" 으로 바뀌고,
 * 서버가 현재 조합을 마친 뒤 실제로 멈춘다.
 */
function VariantProgressNotice({
  progress,
  cancelingJobIds,
  onCancel,
}: {
  progress: VariantProgress;
  cancelingJobIds: readonly string[];
  onCancel: (jobId: string) => void;
}) {
  const { jobId } = progress;
  const canceling = jobId != null && cancelingJobIds.includes(jobId);
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-violet-700">
        변형 중… {progress.doneCount}/{progress.total}
        {progress.currentNo != null ? ` (현재 ${progress.currentNo}번)` : ''}
      </span>
      {jobId != null ? (
        <button
          type="button"
          onClick={() => onCancel(jobId)}
          disabled={canceling}
          title={`이 시험지의 변형 작업(${progress.total}건) 전체가 중단됩니다`}
          className="rounded border border-rose-300 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-700 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {canceling ? '중단하는 중…' : '변형 중단'}
        </button>
      ) : null}
    </span>
  );
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
  onCancel,
  canceling,
  cancelLabel,
  cancelTitle,
  pickMode,
  variantRunning,
  picked,
  onTogglePick,
}: SolutionRowProps) {
  const status = entry?.status ?? (problem.has_solution ? 'done' : 'empty');
  const streaming = status === 'running';
  const body = streaming ? (entry?.streamingText ?? '') : (entry?.text ?? '');
  const { usd, krw } = costAmounts(entry?.cost, usdKrw);
  const tokens = totalTokens(entry?.usage);

  return (
    <li
      className={clsx(
        selected && 'bg-blue-50/40',
        picked && pickMode === 'note' && 'bg-rose-50/60',
        // 변형 모드는 담기(rose)와 다른 색으로 구분한다.
        picked && pickMode === 'variant' && 'bg-violet-50/60',
      )}
    >
      <div className="flex w-full items-start gap-3 px-3 py-2">
        {/* 담기·변형 모드에서만 체크박스가 보인다. 상단 번호 줄과 같은 선택을 공유한다. */}
        {pickMode !== 'none' ? (
          <input
            type="checkbox"
            checked={picked}
            onChange={() => onTogglePick()}
            aria-label={`${problem.no}번 ${pickMode === 'variant' ? '변형' : '오답노트'} 선택`}
            className={clsx(
              'mt-1 h-4 w-4 shrink-0',
              pickMode === 'variant' ? 'accent-violet-600' : 'accent-rose-600',
            )}
          />
        ) : null}
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
              {/* 구획마다 번호가 되돌아가는 교재는 문제지 표기가 따로 있다. */}
              {problem.label && problem.label !== String(problem.no) ? (
                <span className="text-[11px] text-amber-700">
                  문제지 {problem.label}번
                </span>
              ) : null}
              <span className="text-[11px] text-slate-400">{problem.page}쪽</span>
              <StatusBadge status={status} truncated={entry?.truncated ?? false} />
              {/* 변형 모드에서 어떤 문항이 이미 돌고 있는지 행에서 바로 보이게. */}
              {pickMode === 'variant' && variantRunning ? (
                <InlineBadge tone="violet">변형 생성 중</InlineBadge>
              ) : null}
            </span>
            <span className="mt-1 block truncate text-[12px] text-slate-500">
              {status === 'done'
                ? plainPreview(entry?.text ?? '')
                : status === 'running'
                  ? '풀이 중…'
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
            ) : status === 'running' ? (
              // 아직 첫 델타가 오기 전. 여기서도 진행과 중단이 보여야 한다.
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[13px] text-slate-600">
                  <Spinner className="h-3 w-3" /> 풀이 중…
                </span>
                {onCancel ? (
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={canceling}
                    title={cancelTitle}
                    className="rounded border border-rose-600 bg-rose-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-rose-700 disabled:opacity-60"
                  >
                    {canceling ? '중단하는 중…' : cancelLabel}
                  </button>
                ) : null}
              </div>
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

          {status === 'running' && body && onCancel ? (
            <div className="mt-2">
              <button
                type="button"
                onClick={onCancel}
                disabled={canceling}
                title={cancelTitle}
                className="rounded border border-rose-300 bg-white px-2 py-0.5 text-[11px] font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-60"
              >
                {canceling ? '중단하는 중…' : cancelLabel}
              </button>
            </div>
          ) : null}

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

