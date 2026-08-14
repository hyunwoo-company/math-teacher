/**
 * 문항 텍스트화(판독본) 공용 상수와 판정 순수 함수.
 *
 * 스토어(`store/workspace`)·화면(`SolutionsTab`·`TranscriptPanel`·`CenterPanel`)이
 * 함께 쓴다. 스토어 타입을 import 하지 않는다 — 스토어가 이 모듈을 쓰므로 반대
 * 방향 의존을 만들면 순환이 된다(`lib/variant.ts` 와 같은 규칙).
 *
 * ## 진행 여부의 단일 소스
 *
 * **`transcripts[key].status === 'running'`** 하나다. 전체 실행·문항별 재실행이
 * 둘 다 요청 전에 이 자리를 먼저 만들고, 작업이 끝나거나 끊기면 정리한다
 * (`watchJob` 의 finally). 상단 헤더·문항 행·대조 패널이 모두 이 자리만 본다.
 * 따로 집계 상태를 두면 같은 사실의 사본이 생겨 "아래는 판독 중인데 위는 평상"
 * 이라는 괴리가 형태만 바꿔 다시 난다.
 */

import type { JobKind, JobStatus } from '@/types/api';

/** 판독본 출처. 셋의 신뢰도가 다르므로 화면에서 반드시 구분해 보여준다. */
export type TranscriptSource = 'pua' | 'ai' | 'manual';

/**
 * 출처 라벨.
 *  - `pua`    : PDF 텍스트 레이어를 그대로 디코딩한 것. AI 호출 0회, 결정적.
 *  - `ai`     : 크롭 이미지를 AI 가 읽은 것. 비결정적이라 대조가 필요하다.
 *  - `manual` : 사용자가 고친 것. force 없는 재실행이 덮지 않는다.
 */
export const TRANSCRIPT_SOURCE_LABEL: Record<TranscriptSource, string> = {
  pua: '디코딩',
  ai: 'AI 판독',
  manual: '직접 수정',
};

/** `InlineBadge` 의 tone 값(그 컴포넌트가 받는 것과 같은 집합). */
export type TranscriptTone = 'slate' | 'blue' | 'green' | 'amber' | 'rose' | 'violet';

/**
 * 출처별 배지 색. **디코딩만 초록**이다 — 원본 글리프를 그대로 옮긴 것이라 셋 중
 * 신뢰도가 가장 높다. AI 판독은 확인이 필요하다는 뜻으로 호박색을 쓴다.
 */
export const TRANSCRIPT_SOURCE_TONE: Record<TranscriptSource, TranscriptTone> = {
  pua: 'green',
  ai: 'amber',
  manual: 'blue',
};

/**
 * 서버가 준 출처 문자열을 좁힌다.
 *
 * 백엔드가 `transcript_source` 를 Literal 로 좁히지 않았으므로(값이 늘어날 수
 * 있다) 모르는 값은 null 로 떨어뜨려 화면이 깨지지 않게 한다.
 */
export function transcriptSourceOf(value: string | null | undefined): TranscriptSource | null {
  return value === 'pua' || value === 'ai' || value === 'manual' ? value : null;
}

/** 출처 라벨(모르는 값이면 null — 배지를 내지 않는다). */
export function transcriptSourceLabel(value: string | null | undefined): string | null {
  const source = transcriptSourceOf(value);
  return source == null ? null : TRANSCRIPT_SOURCE_LABEL[source];
}

/** 출처 배지 색(모르는 값이면 무채색). */
export function transcriptSourceTone(value: string | null | undefined): TranscriptTone {
  const source = transcriptSourceOf(value);
  return source == null ? 'slate' : TRANSCRIPT_SOURCE_TONE[source];
}

/* ── 판정 ────────────────────────────────────────────────────────── */

/** 판정에 필요한 판독본 항목의 최소 형태(스토어 `TranscriptEntry` 가 이걸 만족한다). */
export interface TranscriptLike {
  /** 확정된 전문. 판독하지 못했으면 빈 문자열. */
  text: string;
  status: 'idle' | 'running' | 'done' | 'error';
}

/** 판독본 캐시를 읽기 전용으로 본 것. key = `${fileId}::${no}`. */
export type TranscriptStatusMap = Readonly<Record<string, TranscriptLike>>;

/** 진행 표시에 필요한 작업의 최소 형태(`Job` 이 이걸 만족한다). */
export interface TranscriptJobLike {
  id: string;
  kind: JobKind;
  node_id: string;
  status: JobStatus;
  total: number;
  done_count: number;
  current_no: number | null;
}

/** 상단에 낼 판독 진행 상황. */
export interface TranscriptProgress {
  /** 끝난 문항 수. */
  doneCount: number;
  /** 전체 대상 문항 수. */
  total: number;
  /** 지금 판독하고 있는 문항 번호. 모르면 null. */
  currentNo: number | null;
  /** [중단] 이 취소할 작업 id. 대응하는 작업을 못 찾았으면 null(버튼을 내지 않는다). */
  jobId: string | null;
}

/** 판독본 캐시 키. 스토어와 이 함수들이 같은 형식을 쓰도록 여기 하나만 둔다. */
export function transcriptCacheKey(fileId: string, no: number): string {
  return `${fileId}::${no}`;
}

/**
 * 그 문항에 **쓸 수 있는 판독본이 있는지**.
 *
 * 이유만 남은 문항(판독 불가)은 없는 것으로 센다 — 서버 `plan_transcribe_job` 도
 * 빈 판독본을 세지 않아 다시 판독 대상이고, 내보낼 때는 이미지로 폴백한다.
 */
export function hasTranscript(
  transcripts: TranscriptStatusMap,
  fileId: string,
  no: number,
): boolean {
  return (transcripts[transcriptCacheKey(fileId, no)]?.text ?? '') !== '';
}

/** 그 문항이 지금 판독 중인지. */
export function isTranscriptRunning(
  transcripts: TranscriptStatusMap,
  fileId: string,
  no: number,
): boolean {
  return transcripts[transcriptCacheKey(fileId, no)]?.status === 'running';
}

/** 그 시험지에서 지금 판독 중인 문항 수. */
export function countRunningTranscripts(
  transcripts: TranscriptStatusMap,
  fileId: string,
): number {
  const prefix = `${fileId}::`;
  let count = 0;
  for (const [key, entry] of Object.entries(transcripts)) {
    if (key.startsWith(prefix) && entry.status === 'running') count += 1;
  }
  return count;
}

/** 문항 목록에서 판정에 필요한 만큼(`Problem` 이 이걸 만족한다). */
export interface ProblemNoLike {
  no: number;
}

/** 판독본이 있는 문항 수. */
export function transcribedCount(
  transcripts: TranscriptStatusMap,
  fileId: string,
  problems: readonly ProblemNoLike[],
): number {
  return problems.filter((problem) => hasTranscript(transcripts, fileId, problem.no)).length;
}

/**
 * 아직 판독본이 없는 문항 번호들.
 *
 * 서버가 재실행에서 실제로 대상으로 삼는 것과 같은 규칙이다("몇 개가 남았나" 를
 * 화면과 서버가 다르게 세면 사용자는 요청한 수보다 적게 처리된 이유를 알 수 없다).
 */
export function untranscribedNumbers(
  transcripts: TranscriptStatusMap,
  fileId: string,
  problems: readonly ProblemNoLike[],
): number[] {
  return problems
    .filter((problem) => !hasTranscript(transcripts, fileId, problem.no))
    .map((problem) => problem.no);
}

/**
 * 문항 전부가 판독됐는지(그때만 전체 실행 버튼을 막는다).
 *
 * 문항이 없으면 막을 근거가 없으므로 false 다(`allPicksRunning` 과 같은 규칙).
 */
export function allTranscribed(
  transcripts: TranscriptStatusMap,
  fileId: string,
  problems: readonly ProblemNoLike[],
): boolean {
  if (problems.length === 0) return false;
  return untranscribedNumbers(transcripts, fileId, problems).length === 0;
}

/** 하나라도 판독본이 있는지(텍스트로 내보낼 수 있는지). */
export function hasAnyTranscript(
  transcripts: TranscriptStatusMap,
  fileId: string,
  problems: readonly ProblemNoLike[],
): boolean {
  return problems.some((problem) => hasTranscript(transcripts, fileId, problem.no));
}

/**
 * 상단에 낼 판독 진행 상황을 계산한다. 진행 중이 아니면 null.
 *
 * 판정 기준은 "아래 패널이 판독 중이면 위에도 반드시 보인다" 다. 그래서 작업
 * 목록(`jobs`)이 아직 안 들어왔더라도 판독 중 자리가 있으면 표시하고, 반대로
 * 자리가 없어도 큐에 걸린(queued) 작업이 있으면 표시한다.
 *
 * `total` 은 작업이 알려 준 값과 (끝난 수 + 진행 중 자리 수) 중 큰 쪽을 쓴다.
 * 작게 잡으면 진행이 100% 를 넘는 표시가 된다.
 */
export function transcriptProgressOf(input: {
  transcripts: TranscriptStatusMap;
  fileId: string;
  jobs: readonly TranscriptJobLike[];
}): TranscriptProgress | null {
  const { transcripts, fileId, jobs } = input;
  const job =
    jobs.find(
      (candidate) =>
        candidate.node_id === fileId &&
        candidate.kind === 'transcribe' &&
        (candidate.status === 'running' || candidate.status === 'queued'),
    ) ?? null;
  const running = countRunningTranscripts(transcripts, fileId);
  if (!job && running === 0) return null;

  const doneCount = job?.done_count ?? 0;
  return {
    doneCount,
    total: Math.max(job?.total ?? 0, doneCount + running),
    currentNo: job?.current_no ?? null,
    jobId: job?.id ?? null,
  };
}
