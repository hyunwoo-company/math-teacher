/**
 * 워크스페이스 전역 상태.
 *
 * 세 패널(트리 / 뷰어 / AI)이 같은 선택 상태와 스트리밍 상태를 공유해야 하므로
 * zustand 스토어 하나로 모았다. 패널 내부 UI 상태(열림/닫힘 등)는 컴포넌트 로컬에 둔다.
 *
 * 정적 export(Tauri) 전제라 서버 컴포넌트에서 미리 받아올 데이터가 없다.
 * 따라서 데이터 로딩은 전부 클라이언트에서 이 스토어의 액션으로 수행한다.
 */

import { create } from 'zustand';
import { api } from '@/lib/api';
import { readStoredApiKey } from '@/lib/http-client';
import {
  initialAccessOk,
  isUnauthorizedError,
  setUnauthorizedHandler,
  writeStoredPassword,
} from '@/lib/access-gate';
import { ApiError, isAbortError, toUserHint, toUserMessage } from '@/lib/api-error';
import { UI_PREFS_STORAGE } from '@/lib/config';
import { mergeUsage } from '@/lib/format';
import { detectProblemNo } from '@/lib/mention';
import { parseNoteAddIntent } from '@/lib/note-intent';
import {
  defaultModelForProvider,
  isProviderAvailable,
  resolveProviderConfig,
  type ProviderConfig,
} from '@/lib/provider-config';
import { isDescendantOf } from '@/lib/tree';
import {
  transcriptCacheKey,
  transcriptSourceOf,
  type TranscriptSource,
} from '@/lib/transcript';
import { variantCacheKey, variantModesOf, type VariantPickKind } from '@/lib/variant';
import { UPLOAD_NOTICE } from '@/lib/upload-notice';
import { uploadTargetLabel } from '@/lib/upload-target';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type Conversation,
  type ConversationMessage,
  type Cost,
  type Effort,
  type EnvResponse,
  type Job,
  type FileDetail,
  type NoteDetail,
  type ProviderChoice,
  type Section,
  type TreeNode,
  type Usage,
  type UsageSummaryResponse,
  type VariantMode,
} from '@/types/api';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type CenterTab = 'pdf' | 'solutions';
/** 중앙에 무엇이 열려 있는지. */
export type OpenKind = 'none' | 'exam' | 'note';

/** 노트 추가 확인 다이얼로그 상태(학생 노트가 없을 때 "만들까요?"). */
export interface NotePrompt {
  kind: 'create-note';
  noteName: string;
  sourceNodeId: string;
  problemNumbers: number[];
}

export interface SolutionEntry {
  no: number;
  /** 확정된 풀이 본문(done 이후). 스트리밍 중에는 빈 문자열일 수 있다. */
  text: string;
  /** 스트리밍 중 누적되는 부분 텍스트. */
  streamingText: string;
  status: 'empty' | 'running' | 'done' | 'error';
  usage: Usage | null;
  cost: Cost | null;
  truncated: boolean;
  error: string | null;
  createdAt: string | null;
}

export interface ChatEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming: boolean;
  usage: Usage | null;
  cost: Cost | null;
  error: string | null;
  createdAt: string;
  /** 이 메시지가 특정 문제를 컨텍스트로 걸고 보낸 것이면 그 번호. */
  problemNo: number | null;
  /** 이 메시지가 컨텍스트로 건 시험지 file_id(문항 첨부 시). "N번 풀이로 저장" 대상. */
  fileId: string | null;
  /** "N번 풀이로 저장" 진행 중. */
  savingSolution?: boolean;
  /** 이 답변을 그 문항 풀이로 저장 완료(피드백 표시용). */
  savedAsSolution?: boolean;
}

/** 변형 탭(mode)별 생성 상태. */
export type VariantStatus = 'idle' | 'streaming' | 'done' | 'error';

/**
 * 한 문항의 특정 mode 변형 결과. mode 당 1개만 캐시한다.
 * `variants[key][mode]` 에 저장된다(key = `${fileId}::${no}`).
 * 한 번 done 이 되면 명시적 재생성(force) 전까지 재호출하지 않는다.
 */
export interface VariantEntry {
  mode: VariantMode;
  /** 확정 본문(done 이후). 스트리밍 중에는 빈 문자열. */
  text: string;
  /** 스트리밍 중 누적되는 부분 텍스트. */
  streamingText: string;
  status: VariantStatus;
  usage: Usage | null;
  cost: Cost | null;
  error: string | null;
}

/** 한 문항의 mode 별 변형 캐시. */
export type VariantByMode = Partial<Record<VariantMode, VariantEntry>>;

/** 판독본 상태. `done` 은 "판독 시도가 끝났다" 는 뜻이다(전문이 없을 수도 있다). */
export type TranscriptStatus = 'idle' | 'running' | 'done' | 'error';

/**
 * 한 문항의 판독본(문항 텍스트화 결과). `transcripts[`${fileId}::${no}`]` 에 산다.
 *
 * **이 자리가 진행 표시와 배지의 단일 소스다**(`lib/transcript.ts` 참고).
 * 전문은 서버가 저장한 값이고, 화면은 여기만 읽는다. 파일 상세의
 * `has_transcript` 를 따로 보면 같은 사실의 사본이 생겨 어긋난다.
 */
export interface TranscriptEntry {
  no: number;
  /** 확정된 전문. 판독하지 못했으면 빈 문자열. */
  text: string;
  /** AI 판독(2차)이 흐르는 중의 부분 텍스트. 1차 디코딩은 델타가 없다. */
  streamingText: string;
  status: TranscriptStatus;
  /** `pua` / `ai` / `manual`. 전문이 없으면 null. */
  source: TranscriptSource | null;
  /** 판독 실패·불가 이유(배지로 보여준다). */
  note: string | null;
  /** 이 문항이 어느 경로로 판독 중인지(진행 중에만 의미가 있다). */
  route: 'pua' | 'ai' | null;
  usage: Usage | null;
  cost: Cost | null;
  error: string | null;
  /** 편집 저장 요청이 진행 중인지. */
  saving: boolean;
}

export interface SolveProgress {
  running: boolean;
  total: number;
  doneCount: number;
  currentNo: number | null;
  /** 전체 풀이가 아니라 단일 문제 재풀이인 경우 true. */
  partial: boolean;
  error: string | null;
  aborted: boolean;
}

export interface SessionTotals {
  usage: Usage | null;
  usd: number;
  krw: number;
  /** 과금 대상 호출 수. */
  billedCalls: number;
  /** 구독으로 처리된 호출 수(과금 없음). */
  subscriptionCalls: number;
}

export interface ToastMessage {
  kind: 'error' | 'info' | 'success';
  message: string;
  hint?: string | null;
}

interface UiPrefs {
  model?: string;
  effort?: Effort;
  provider?: ProviderChoice;
  rightWidth?: number;
  /** 좌측 파일 트리 패널 너비(px). */
  leftWidth?: number;
  /** 좌측 파일 트리 패널 접힘 여부. */
  leftCollapsed?: boolean;
  /** 우측 프롬프트 패널 접힘 여부. */
  rightCollapsed?: boolean;
  /** 마지막으로 열어 본 시험지 파일 id(새로고침 복원용). null = 없음. */
  lastFileId?: string | null;
  /** 마지막으로 보던 전역 대화 id(새로고침 복원용). null = 없음(새 대화 초안). */
  lastConversationId?: string | null;
}

export const RIGHT_MIN = 320;
export const RIGHT_MAX = 720;
export const RIGHT_DEFAULT = 400;

export const LEFT_MIN = 200;
export const LEFT_MAX = 480;
export const LEFT_DEFAULT = 280;

interface WorkspaceState {
  /* 환경 */
  env: EnvResponse | null;
  envStatus: LoadStatus;
  envError: string | null;
  onboardingSkipped: boolean;
  /**
   * 이 브라우저에 API 키를 갖고 있는지.
   * 웹 모드에서는 서버가 키를 저장하지 않으므로 `env.api_key_set` 이 계속 false 다.
   * 그것만 보고 판단하면 키를 넣어도 온보딩이 다시 뜬다.
   */
  hasLocalApiKey: boolean;

  /* 접속 비밀번호 게이트 */
  /**
   * 접근이 확보됐는지. `env.auth_required` 가 false 면 항상 true.
   * true 이면 3분할 UI, false 이면(비번 요구 환경) 로그인 화면을 띄운다.
   */
  accessOk: boolean;
  /** 로그인 화면 인라인 에러(비번 오류/세션 만료 안내). */
  authError: string | null;
  /** 로그인 검증 진행 중. */
  authChecking: boolean;

  /** 계약 3-C: provider/모델 선택 정규화 결과. loadEnv 시 갱신. */
  providerConfig: ProviderConfig | null;

  /* 트리 */
  /** 좌측 패널에 표시 중인 섹션. */
  section: Section;
  nodes: TreeNode[];
  treeStatus: LoadStatus;
  treeError: string | null;
  expanded: Record<string, boolean>;
  /**
   * 트리에서 마지막으로 선택/포커스한 노드(폴더 또는 파일).
   * 업로드 대상 폴더를 정하는 데 쓴다. 선택된 "파일"(selectedFileId)과는 다르다.
   */
  focusedNodeId: string | null;
  pendingOp: string | null;

  /* 선택 (중앙에 열린 대상) */
  openKind: OpenKind;
  selectedFileId: string | null;
  fileDetail: FileDetail | null;
  fileStatus: LoadStatus;
  fileError: string | null;
  selectedProblemNo: number | null;

  /* 오답노트 (중앙에 노트가 열렸을 때) */
  selectedNoteId: string | null;
  noteDetail: NoteDetail | null;
  noteStatus: LoadStatus;
  noteError: string | null;
  /** "학생 노트가 없습니다. 만들까요?" 확인 UI. */
  notePrompt: NotePrompt | null;

  /* 전역(파일 무관) 자유 대화 (ChatGPT식) */
  conversations: Conversation[];
  /** 현재 열려 있는 대화 id. null = 아직 대화가 없는 "새 대화" 초안. */
  activeConversationId: string | null;
  /** 백엔드가 이력을 잘라 보냈으면 생략된 이전 메시지 수. */
  chatTruncatedBefore: number;

  /* 중앙 패널 */
  activeTab: CenterTab;
  /** 뷰어가 스크롤해야 할 대상(문제 클릭 시 갱신). */
  focusRequest: { no: number; page: number; token: number } | null;

  /* 풀이 */
  solutions: Record<number, SolutionEntry>;
  solutionsStatus: LoadStatus;
  solve: SolveProgress;

  /**
   * 변형 문제 생성 결과. key = `${fileId}::${no}`, 그 아래 mode 별 1개.
   * 시험지 풀이 탭과 오답노트가 같은 문항(file_id+problem_no)을 참조하므로
   * 이 키 하나로 두 화면이 상태(캐시)를 공유한다.
   */
  variants: Record<string, VariantByMode>;

  /**
   * 판독본(문항 텍스트화). key = `${fileId}::${no}`.
   *
   * 진행 표시·출처 배지·내보내기 활성화가 **모두 이 자리만** 본다. 시험지를 열 때
   * `loadTranscripts` 가 서버 저장본으로 채우고, 작업 이벤트와 편집 저장이 갱신한다.
   */
  transcripts: Record<string, TranscriptEntry>;

  /**
   * 특정 문항(file_id + problem_no)의 저장 풀이/on-demand 풀이 캐시.
   * key = `${fileId}::${no}`. 오답노트 인라인 "풀이 보기" 처럼 시험지가 열려 있지
   * 않은 화면에서 그 문항의 풀이를 조회/생성/표시하는 데 쓴다.
   * 파일별 `solutions` 맵과 달리 열린 파일과 무관하게 문항 단위로 캐시한다.
   * done = 저장/생성 완료, running = 생성 중, empty = 조회했으나 저장분 없음.
   */
  problemSolutions: Record<string, SolutionEntry>;

  /* 채팅 */
  messages: ChatEntry[];
  chatStatus: LoadStatus;
  chatSending: boolean;

  /* 설정 */
  model: string;
  effort: Effort;
  provider: ProviderChoice;

  /* 사용량 누적 */
  totals: SessionTotals;
  /**
   * agy 쿼터 기반 사용량 요약(최근 24h/7일/누적). 신규 엔드포인트라 아직 없을 수 있어
   * null 이면 상태 바가 세션 값만 표시한다(화면이 깨지지 않게).
   */
  usageSummary: UsageSummaryResponse | null;

  /* UI */
  rightWidth: number;
  leftWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  toast: ToastMessage | null;

  /* 액션 */
  hydratePrefs: () => void;
  loadEnv: () => Promise<void>;
  saveApiKey: (key: string) => Promise<boolean>;
  clearApiKey: () => Promise<void>;
  skipOnboarding: () => void;

  /* 접속 비밀번호 게이트 */
  /** 비번 검증 후 통과하면 저장하고 트리를 불러온다. 성공 여부를 반환. */
  login: (password: string) => Promise<boolean>;
  /** 저장 비번을 지우고 로그인 화면으로 되돌린다. */
  logout: () => void;
  /** 401(세션 만료/비번 변경) 을 받았을 때 저수준 클라이언트가 깨우는 콜백. */
  handleUnauthorized: () => void;

  setSection: (section: Section) => Promise<void>;
  loadTree: (section?: Section) => Promise<void>;
  /**
   * 새로고침 복원: prefs.lastFileId 가 트리에 실제 존재하면 그 파일을 자동으로 연다.
   * 이미 다른 파일을 열었으면(경합) 아무것도 안 한다.
   */
  restoreLastOpen: () => Promise<void>;
  toggleExpanded: (id: string) => void;
  focusNode: (id: string | null) => void;
  setExpanded: (id: string, value: boolean) => void;
  /** 펼쳐 둔 폴더를 전부 접는다(좌측 패널의 [모든 폴더 닫기]). */
  collapseAll: () => void;
  createFolder: (name: string, parentId: string | null) => Promise<boolean>;
  createNote: (name: string, parentId: string | null) => Promise<boolean>;
  renameNode: (id: string, name: string) => Promise<boolean>;
  moveNode: (id: string, parentId: string | null) => Promise<boolean>;
  /**
   * 여러 노드를 한 폴더로 옮긴다(트리 다중 선택 드래그).
   *
   * 서버 이동을 순차로 부른다. 실패한 것만 모아 토스트 한 건으로 알리고 성공분은
   * 그대로 둔다. 트리는 하나라도 옮겼을 때 마지막에 한 번만 다시 읽는다.
   */
  moveNodes: (ids: string[], parentId: string | null) => Promise<void>;
  deleteNode: (id: string) => Promise<boolean>;
  /**
   * 여러 노드를 지운다(트리 다중 선택 · 드래그 삭제).
   *
   * `moveNodes` 와 같은 관례다: 서버 삭제를 순차로 부르고, 실패만 모아 토스트 한 건으로
   * 알리고, 하나라도 지웠으면 마지막에 트리를 한 번만 다시 읽는다.
   * 상위와 하위가 함께 넘어오면 상위만 부른다(하위는 서버가 함께 지운다).
   */
  deleteNodes: (ids: string[]) => Promise<void>;
  uploadFiles: (files: File[], parentId: string | null) => Promise<void>;

  /**
   * 열려 있는 시험지를 원본 그대로 다시 추출한다(AI 호출 0회).
   * 성공하면 문항 목록과 트리를 갱신하고 **기존 풀이는 사라진다**.
   */
  reextractFile: (id: string) => Promise<void>;
  /** 재추출 진행 중인 파일 id (버튼 비활성/스피너용). */
  reextracting: string | null;

  /** 트리에서 파일형 노드를 열 때. 섹션에 따라 시험지/노트로 분기. */
  openNode: (id: string) => Promise<void>;
  selectFile: (id: string) => Promise<void>;
  selectNote: (id: string) => Promise<void>;
  refreshNote: () => Promise<void>;
  deleteNoteItem: (itemId: string) => Promise<void>;
  selectProblem: (no: number | null) => void;
  focusProblem: (no: number) => void;
  setActiveTab: (tab: CenterTab) => void;

  /* 전역 대화 (ChatGPT식) */
  /** 대화 목록을 새로 불러온다(updated_at 내림차순). 실패는 조용히 무시. */
  loadConversations: () => Promise<void>;
  /** 부트스트랩: 목록을 불러오고 마지막으로 보던 대화(prefs.lastConversationId)를 복원한다. */
  bootstrapConversations: () => Promise<void>;
  /** 대화를 열어 메시지를 복원한다. */
  openConversation: (id: string) => Promise<void>;
  /** "+ 새 대화": 활성 대화를 비운다(실제 생성은 첫 전송 시). */
  newConversation: () => void;
  /** 대화 이름을 바꾼다. */
  renameConversation: (id: string, title: string) => Promise<void>;
  /** 대화를 삭제한다. 활성 대화였으면 최신 대화로 폴백(없으면 새 대화 초안). */
  deleteConversation: (id: string) => Promise<void>;
  /** assistant 메시지(문항 컨텍스트 첨부)를 그 문항의 풀이로 저장한다. */
  saveSolutionFromMessage: (messageId: string) => Promise<void>;

  /** agy 쿼터 사용량 요약을 새로 조회한다. 실패는 조용히 무시(세션 값만 표시). */
  loadUsageSummary: () => Promise<void>;

  /* 오답노트 담기 */
  addProblemsToNote: (
    noteId: string,
    sourceNodeId: string,
    problemNumbers: number[],
    memo?: string | null,
  ) => Promise<boolean>;
  /**
   * 문항들을 **여러 오답노트에** 담는다. 노트별로 순차 호출하고 결과를 모아
   * 토스트를 **한 번만** 낸다(노트마다 토스트가 뜨면 화면이 가려진다).
   * 한 노트가 실패해도 나머지는 계속 담는다.
   */
  addProblemsToNotes: (
    noteIds: string[],
    sourceNodeId: string,
    problemNumbers: number[],
    memo?: string | null,
  ) => Promise<boolean>;
  confirmNotePrompt: () => Promise<void>;
  cancelNotePrompt: () => void;

  /**
   * 시험지 풀이를 스트리밍으로 시작한다.
   * `opts.force` 가 아니면 이미 저장 풀이가 있는(status='done') 문항은 재호출하지
   * 않는다(캐시 우선). 단일 문항 "다시 풀기" 처럼 명시적 재풀이는 force 로 부른다.
   */
  startSolve: (problemNumbers: number[] | null, opts?: { force?: boolean }) => Promise<void>;
  /** 진행 중인 작업을 취소한다(서버 큐에서 뺀다). */
  cancelJob: (jobId: string) => Promise<void>;
  /** 앱이 뜰 때 진행 중 작업을 받아 구독을 되살린다(새로고침 복구). */
  loadJobs: () => Promise<void>;
  /** 진행 중 + 최근 종료 작업. 상단 배너가 쓴다. */
  jobs: Job[];

  /**
   * 오답노트에 담을 문항 고르기 모드.
   *
   * 상단 번호 줄과 [풀이] 탭 목록 **양쪽**에서 같은 선택을 공유해야 해서
   * 컴포넌트 지역 상태가 아니라 스토어에 둔다.
   */
  notePicking: boolean;
  /** 고른 문항 번호. */
  notePicked: number[];
  /** 담기 모드를 켠다(이미 켜져 있으면 유지). */
  startNotePicking: () => void;
  /** 담기 모드를 끄고 선택을 비운다. */
  stopNotePicking: () => void;
  /** 문항 하나를 선택/해제한다. */
  toggleNotePick: (no: number) => void;
  /** 주어진 번호들로 선택을 통째로 바꾼다(전체 선택/해제용). */
  setNotePicked: (numbers: number[]) => void;

  /**
   * 변형을 만들 문항 고르기 모드.
   *
   * 담기 모드(`notePicking`)와 **상호 배타**다 — 한쪽을 켜면 다른 쪽은 꺼진다.
   * 두 모드가 같은 체크박스를 쓰므로, 동시에 켜지면 체크 하나가 두 뜻을 갖는다.
   */
  variantPicking: boolean;
  /** 변형을 만들 문항 번호(오름차순). */
  variantPicked: number[];
  /** 만들 변형 유형. `'all'` 은 3종 모두를 뜻한다. */
  variantKind: VariantPickKind;
  /** 변형 모드를 켠다(담기 모드는 끈다). 이전 선택은 버린다. */
  startVariantPicking: () => void;
  /** 변형 모드를 끄고 선택을 비운다. */
  stopVariantPicking: () => void;
  /** 문항 하나를 선택/해제한다. */
  toggleVariantPick: (no: number) => void;
  /** 주어진 번호들로 선택을 통째로 바꾼다(전체 선택/해제용). */
  setVariantPicked: (numbers: number[]) => void;
  /** 만들 변형 유형을 고른다(단일 선택). */
  setVariantKind: (kind: VariantPickKind) => void;
  /**
   * 고른 문항 × 고른 유형을 한 작업으로 걸고 변형 모드를 닫는다.
   * `opts.force` 면 이미 만들어 둔 조합도 다시 만든다(그게 아니면 서버가
   * 건너뛰고, 남는 게 없으면 400 으로 거절한다).
   */
  startVariantBatch: (opts?: { force?: boolean }) => Promise<void>;
  /**
   * 취소를 요청했지만 아직 서버가 멈추지 않은 작업 id.
   *
   * 프로바이더 호출은 중간에 끊을 수 없어 **현재 문항을 마친 뒤** 멈춘다.
   * 그 사이 아무 표시가 없으면 "중지가 안 된다" 고 느끼므로 따로 들고 있는다.
   */
  cancelingJobIds: string[];

  /**
   * 그 문항(file_id + problem_no)의 저장 풀이를 조회해 `problemSolutions` 에 채운다.
   * 저장분이 있으면 그대로 표시용으로 캐시하고, 없으면 빈 상태로 둔다(풀이는 하지 않음).
   * 이미 캐시(done/running/empty)가 있으면 재조회하지 않는다(오답노트 인라인 풀이용).
   */
  loadProblemSolution: (fileId: string, no: number) => Promise<void>;

  /**
   * 그 문항(file_id + problem_no)을 1회 풀어 `problemSolutions` 에 캐시한다.
   * 이미 done(저장 풀이 존재)이면 `opts.force` 일 때만 재풀이한다. 스트리밍 중이면 no-op.
   * 시험지가 열려 있지 않은 오답노트 인라인 "풀이 만들기" 에서 쓴다.
   */
  solveProblem: (fileId: string, no: number, opts?: { force?: boolean }) => Promise<void>;

  /**
   * 그 시험지에 저장된 변형을 조회해 `variants` 캐시를 채운다.
   *
   * 시험지를 열 때(`selectFile`)와, 변형 패널이 캐시 없이 열릴 때(오답노트가
   * 그렇다 — `selectNote` 는 시험지를 열지 않는다) 쓴다. 실패는 조용히 넘긴다.
   */
  loadVariants: (fileId: string) => Promise<void>;

  /**
   * 그 문항의 동일 유형 변형 문제를 스트리밍으로 생성한다.
   * mode 별로 1개만 캐시한다: 이미 done 이면 재호출하지 않는다(no-op).
   * `opts.force` 가 true 면 done 이어도 다시 생성한다("다시 생성").
   * 스트리밍 중에는 force 여부와 무관하게 항상 no-op(연타/중복 방지).
   */
  generateVariant: (
    fileId: string,
    no: number,
    mode: VariantMode,
    opts?: { force?: boolean },
  ) => Promise<void>;

  /**
   * 그 시험지에 저장된 판독본을 조회해 `transcripts` 캐시를 채운다.
   *
   * 시험지를 열 때(`selectFile`)와 판독 작업이 끝난 뒤(`watchJob` 의 finally)에
   * 부른다 — 이벤트로 받은 값과 서버 저장본을 마지막에 한 번 맞춘다.
   * 판독 중인 자리는 덮지 않는다(흐르고 있는 결과가 옛 값으로 되돌아간다).
   */
  loadTranscripts: (fileId: string) => Promise<void>;

  /**
   * 문항을 텍스트로 옮기는 작업을 큐에 넣는다.
   *
   * `problemNumbers` 가 null 이면 시험지 전체다. 1차가 PDF 디코딩(AI 호출 0회)이라
   * AI 연결이 없어도 유효한 작업이다. 이미 판독본이 있는 문항은 서버가 건너뛰고,
   * 남는 게 없으면 400 `already_transcribed` 로 거절한다 — `opts.force` 로 뚫는다.
   */
  startTranscribe: (
    problemNumbers: number[] | null,
    opts?: { force?: boolean },
  ) => Promise<void>;

  /**
   * 대조 화면에서 고친 판독본을 저장한다(출처가 `manual` 이 된다).
   *
   * **빈 문자열이면 판독본을 지운다**(되돌리는 경로). 실패는 토스트로 알리고
   * 화면의 값을 바꾸지 않는다.
   *
   * @returns 저장 성공 여부(호출부가 편집 모드를 닫을지 결정한다).
   */
  saveTranscript: (fileId: string, no: number, text: string) => Promise<boolean>;

  sendChat: (message: string) => Promise<void>;
  handleNoteAddIntent: (
    intent: { problemNos: number[]; noteQuery: string | null },
    sourceNodeId: string,
    availableNos: readonly number[],
  ) => Promise<void>;
  abortChat: () => void;

  setModel: (model: string) => void;
  setEffort: (effort: Effort) => void;
  setProvider: (provider: ProviderChoice) => void;
  setRightWidth: (width: number) => void;
  setLeftWidth: (width: number) => void;
  toggleLeftCollapsed: () => void;
  toggleRightCollapsed: () => void;

  showToast: (toast: ToastMessage) => void;
  dismissToast: () => void;
}

/* 스트림 중단 컨트롤러는 상태가 아니라 모듈 변수로 둔다(직렬화 대상 아님). */
let chatController: AbortController | null = null;
let chatSeq = 0;

/**
 * 작업 구독 컨트롤러(job_id → controller). 직렬화 대상 아님.
 *
 * **이 abort 는 "그만 본다" 는 뜻이지 "작업을 멈춘다" 가 아니다.** 작업은 서버
 * 큐에서 돌고 있어 구독을 끊어도 계속된다. 멈추려면 `cancelJob` 을 쓴다.
 */
const jobSubscriptions = new Map<string, AbortController>();

/** 진행 중인 저장 변형 조회(file_id → 약속). 같은 파일을 겹쳐 조회하지 않는다. */
const variantLoads = new Map<string, Promise<void>>();

/** 진행 중인 저장 판독본 조회(file_id → 약속). */
const transcriptLoads = new Map<string, Promise<void>>();

/**
 * 판독 작업이 채우기로 한 문항들(job_id → 문항 번호).
 *
 * 구독이 끝났는데 결과가 안 온 자리를 정리할 때 쓴다. `variantJobTargets` 과 같은
 * 이유다 — "그 시험지의 running 전부" 를 정리하면 같은 시험지의 **다른** 판독
 * 작업이 큐에서 잡아 둔 자리까지 지워진다.
 */
const transcribeJobTargets = new Map<string, number[]>();

/** 생성 요청을 보내는 중인 (문항, 유형). 조회 대기 사이의 재진입을 막는다. */
const variantStarting = new Set<string>();

/**
 * 작업이 만들기로 한 (문항, 유형)들(job_id → 대상).
 *
 * 구독이 끝났는데 결과가 안 온 자리를 정리할 때 쓴다. 이 목록 없이 "그 시험지의
 * streaming 전부" 를 정리하면, 같은 시험지의 **다른** 변형 작업이 큐에서 기다리며
 * 잡아 둔 자리까지 같이 지워진다.
 */
const variantJobTargets = new Map<string, VariantTargetRef[]>();

interface VariantTargetRef {
  no: number;
  mode: VariantMode;
}

/** 이 작업이 채울 자리를 기억한다(이미 있으면 이어 붙인다). */
function rememberVariantTargets(jobId: string, targets: VariantTargetRef[]): void {
  const current = variantJobTargets.get(jobId) ?? [];
  variantJobTargets.set(jobId, [...current, ...targets]);
}

/** 이 판독 작업이 채울 문항들을 기억한다. */
function rememberTranscribeTargets(jobId: string, numbers: readonly number[]): void {
  const current = transcribeJobTargets.get(jobId) ?? [];
  transcribeJobTargets.set(jobId, [...current, ...numbers]);
}

/**
 * 작업 이벤트를 구독해 화면 상태에 반영한다.
 *
 * 구독은 "보기" 일 뿐이라 끊어도 작업은 서버에서 계속된다. 그래서 여기서는
 * 어떤 파일이 열려 있는지와 무관하게 결과를 스토어에 넣는다. 열려 있지 않은
 * 파일의 결과도 `problemSolutions` 캐시에 들어가므로 나중에 열면 바로 보인다.
 */
async function watchJob(job: Job): Promise<void> {
  if (jobSubscriptions.has(job.id)) return;
  const controller = new AbortController();
  jobSubscriptions.set(job.id, controller);

  const { setState, getState } = useWorkspace;
  const fileId = job.node_id;
  const isSolve = job.kind === 'solve';
  const isTranscribe = job.kind === 'transcribe';
  // OCR 은 **페이지 단위**로 진행한다(`no` 가 문항이 아니라 페이지 번호다).
  // 문항 상태를 건드리는 분기에 흘러들면 없는 문항의 빈 풀이 엔트리가 생긴다.
  const isOcr = job.kind === 'ocr';
  /** 판독본 자리를 갱신한다(없으면 만들어서). */
  const touchTranscript = (no: number, patch: (entry: TranscriptEntry) => TranscriptEntry) => {
    const key = transcriptCacheKey(fileId, no);
    setState((state) => ({
      transcripts: {
        ...state.transcripts,
        [key]: patch(state.transcripts[key] ?? emptyTranscript(no)),
      },
    }));
  };
  /** 이 작업이 다루는 문항. variant 는 이벤트 data 의 no 를 그대로 쓴다. */
  const touch = (no: number, patch: (entry: SolutionEntry) => SolutionEntry) => {
    const key = variantKey(fileId, no);
    setState((state) => ({
      // 그 시험지가 열려 있으면 풀이 탭도 함께 갱신한다.
      solutions:
        state.selectedFileId === fileId
          ? patchEntry(state.solutions, no, patch)
          : state.solutions,
      // 문항 캐시는 **없으면 만들어서** 채운다. 열려 있지 않은 시험지의 결과도
      // 받아 두어야 나중에 그 문항을 열었을 때 바로 보인다.
      problemSolutions: {
        ...state.problemSolutions,
        [key]: patch(state.problemSolutions[key] ?? emptyEntry(no)),
      },
    }));
  };

  try {
    for await (const event of api.jobEvents(job.id, controller.signal)) {
      switch (event.type) {
        case 'snapshot':
          setState((state) => ({
            jobs: patchJobProgress(state.jobs, job.id, (item) => ({
              ...item,
              status: event.status,
              total: event.total,
              done_count: event.done_count,
              current_no: event.current_no,
            })),
            solve:
              state.selectedFileId === fileId && isSolve
                ? {
                    ...state.solve,
                    running: event.status === 'running' || event.status === 'queued',
                    total: event.total,
                    doneCount: event.done_count,
                    currentNo: event.current_no,
                  }
                : state.solve,
          }));
          // 진행 중이던 문항의 부분 텍스트를 이어서 보여준다.
          if (event.current_no != null) {
            const no = event.current_no;
            const text = event.partial_text;
            if (isSolve && text) {
              touch(no, (entry) => ({ ...entry, status: 'running', streamingText: text }));
            }
            // 판독은 1차 디코딩이 델타 없이 끝나므로 부분 텍스트가 없어도
            // "판독 중" 자리는 되살려야 한다(새로고침 복구).
            if (isTranscribe) {
              touchTranscript(no, (entry) => ({
                ...entry,
                status: 'running',
                streamingText: text,
              }));
            }
          }
          break;

        case 'start':
          setState((state) => ({
            solve:
              state.selectedFileId === fileId && isSolve
                ? { ...state.solve, total: event.total, running: true }
                : state.solve,
          }));
          break;

        case 'problem':
          setState((state) => ({
            jobs: patchJobProgress(state.jobs, job.id, (item) => ({
              ...item,
              status: 'running',
              current_no: event.no,
            })),
            solve:
              state.selectedFileId === fileId && isSolve
                ? { ...state.solve, currentNo: event.no }
                : state.solve,
          }));
          if (isTranscribe) {
            // `route` 로 이 문항이 디코딩인지 AI 인지 미리 알 수 있다(비용이 다르다).
            const route = event.route === 'ai' ? 'ai' : event.route === 'pua' ? 'pua' : null;
            touchTranscript(event.no, (entry) => ({
              ...entry,
              status: 'running',
              streamingText: '',
              route,
              error: null,
            }));
            break;
          }
          // 풀이가 아닌 작업(변형)은 풀이 자리를 건드리지 않는다.
          if (!isSolve) break;
          touch(event.no, (entry) => ({
            ...entry,
            status: 'running',
            streamingText: '',
            error: null,
          }));
          break;

        case 'delta': {
          if (event.no == null) break;
          if (isTranscribe) {
            const no = event.no;
            touchTranscript(no, (entry) => ({
              ...entry,
              status: 'running',
              streamingText: entry.streamingText + event.text,
            }));
            break;
          }
          const mode = eventVariantMode(event);
          if (!isSolve && mode) {
            const key = variantKey(fileId, event.no);
            setState((state) => ({
              variants: patchVariant(state.variants, key, mode, (entry) => ({
                ...entry,
                status: 'streaming',
                streamingText: entry.streamingText + event.text,
              })),
            }));
            break;
          }
          touch(event.no, (entry) => ({
            ...entry,
            status: 'running',
            streamingText: entry.streamingText + event.text,
          }));
          break;
        }

        case 'done': {
          if (event.no == null) break;
          if (isTranscribe) {
            const no = event.no;
            setState((state) => ({
              jobs: patchJobProgress(state.jobs, job.id, (item) => ({
                ...item,
                done_count: item.done_count + 1,
              })),
              totals:
                // 1차 디코딩은 AI 호출이 0회다 — 호출로 세면 사용량이 부풀려진다.
                event.usage || event.cost
                  ? accumulate(state.totals, event.usage, event.cost)
                  : state.totals,
            }));
            // 필드명이 REST 조회(`transcript_source`/`transcript_note`)와 다르다.
            // SSE 는 짧은 이름(`source`/`note`)을 쓴다 — 백엔드
            // `ai_service.transcribe_events` 가 계약의 소스다.
            touchTranscript(no, (entry) => ({
              ...entry,
              status: 'done',
              // `불가` 판정(transcript=null)은 **이유만** 남기고 전문을 지우지 않는다.
              // AI 판정은 비결정적이라 그 변동으로 확보한 데이터를 잃으면 안 된다
              // (서버 `_save_transcript_note` 와 같은 규칙).
              text: event.transcript ?? entry.text,
              streamingText: '',
              source:
                event.transcript == null ? entry.source : transcriptSourceOf(event.source),
              note: event.note ?? null,
              route: null,
              usage: event.usage,
              cost: event.cost,
              error: null,
            }));
            break;
          }
          const mode = eventVariantMode(event);
          if (!isSolve && mode) {
            const key = variantKey(fileId, event.no);
            setState((state) => ({
              jobs: patchJobProgress(state.jobs, job.id, (item) => ({
                ...item,
                done_count: item.done_count + 1,
              })),
              variants: patchVariant(state.variants, key, mode, (entry) => ({
                ...entry,
                status: 'done',
                text: event.solution || entry.streamingText,
                streamingText: '',
                usage: event.usage,
                cost: event.cost,
                error: null,
              })),
              totals: accumulate(state.totals, event.usage, event.cost),
            }));
            break;
          }
          setState((state) => ({
            jobs: patchJobProgress(state.jobs, job.id, (item) => ({
              ...item,
              done_count: item.done_count + 1,
            })),
            solve:
              state.selectedFileId === fileId && isSolve
                ? { ...state.solve, doneCount: state.solve.doneCount + 1 }
                : state.solve,
            totals: accumulate(state.totals, event.usage, event.cost),
          }));
          // 진행률까지만 세고 끝낸다. `no` 가 페이지 번호라 문항 엔트리를
          // 만들면 존재하지 않는 문항의 빈 풀이가 화면에 남는다.
          if (isOcr) break;
          touch(event.no, (entry) => ({
            ...entry,
            status: 'done',
            text: event.solution || entry.streamingText,
            streamingText: '',
            usage: event.usage,
            cost: event.cost,
            truncated: event.truncated,
            error: null,
            createdAt: new Date().toISOString(),
          }));
          break;
        }

        case 'error': {
          if (event.no == null) break;
          if (isTranscribe) {
            const no = event.no;
            setState((state) => ({
              jobs: patchJobProgress(state.jobs, job.id, (item) => ({
                ...item,
                done_count: item.done_count + 1,
              })),
            }));
            // 전문은 건드리지 않는다(AI 연결이 없어 못 읽은 것이 이미 확보한
            // 판독본을 지울 근거는 아니다).
            touchTranscript(no, (entry) => ({
              ...entry,
              status: 'error',
              streamingText: '',
              route: null,
              error: event.message,
            }));
            break;
          }
          const mode = eventVariantMode(event);
          if (!isSolve && mode) {
            const key = variantKey(fileId, event.no);
            setState((state) => ({
              variants: patchVariant(state.variants, key, mode, (entry) => ({
                ...entry,
                status: 'error',
                error: event.message,
              })),
            }));
            break;
          }
          setState((state) => ({
            jobs: patchJobProgress(state.jobs, job.id, (item) => ({
              ...item,
              done_count: item.done_count + 1,
            })),
            solve:
              state.selectedFileId === fileId && isSolve
                ? { ...state.solve, doneCount: state.solve.doneCount + 1 }
                : state.solve,
          }));
          touch(event.no, (entry) => ({
            ...entry,
            status: 'error',
            error: event.message,
          }));
          break;
        }

        case 'end': {
          const finalStatus = event.status ?? 'done';
          setState((state) => ({
            jobs: patchJobProgress(state.jobs, job.id, (item) => ({
              ...item,
              status: finalStatus,
              current_no: null,
            })),
            cancelingJobIds: state.cancelingJobIds.filter((id) => id !== job.id),
            solve:
              state.selectedFileId === fileId && isSolve
                ? {
                    ...state.solve,
                    running: false,
                    currentNo: null,
                    aborted: finalStatus === 'canceled',
                  }
                : state.solve,
          }));
          break;
        }

        default:
          break;
      }
    }
  } catch (error) {
    if (!isAbortError(error)) {
      setState((state) => ({
        solve:
          state.selectedFileId === fileId
            ? { ...state.solve, running: false, error: toUserMessage(error) }
            : state.solve,
      }));
    }
  } finally {
    jobSubscriptions.delete(job.id);
    // 이 작업이 채우기로 한 변형 자리 중 결과가 안 온 것을 정리한다. 안 하면
    // 취소·중단 시 남은 문항이 영원히 "생성 중…" 으로 돈다. 시험지가 열려
    // 있는지와 무관하다 — 오답노트도 같은 캐시를 본다.
    const pending = variantJobTargets.get(job.id) ?? [];
    variantJobTargets.delete(job.id);
    // 판독도 같다. 중단하면 시작조차 못 한 문항이 영원히 "판독 중" 으로 남는다.
    const pendingTranscripts = transcribeJobTargets.get(job.id) ?? [];
    transcribeJobTargets.delete(job.id);
    setState((state) => ({
      variants: pending.reduce(
        (variants, target) =>
          settleVariant(variants, variantKey(fileId, target.no), target.mode),
        state.variants,
      ),
      transcripts: pendingTranscripts.reduce(
        (transcripts, no) => settleTranscript(transcripts, transcriptCacheKey(fileId, no)),
        state.transcripts,
      ),
      ...(state.selectedFileId === fileId
        ? {
            solutions: settleRunning(state.solutions),
            solve: { ...state.solve, running: false, currentNo: null },
          }
        : {}),
    }));
    void getState().loadJobs();
    void getState().loadUsageSummary();
    // 판독본은 마지막에 서버 저장본으로 한 번 맞춘다. 작업이 저장한 이유(note)는
    // 이벤트에 다 실리지 않고(AI 연결 부재 등), 진행의 단일 소스는 저장된 값이다.
    if (isTranscribe) void getState().loadTranscripts(fileId);
  }
}

/**
 * 진행 중 작업의 카운터를 스토어 `jobs` 배열에도 반영한다.
 *
 * 배너는 `jobs` 를 읽는다. 이벤트로 화면만 갱신하고 이 배열을 놔두면 진행률이
 * "3/22" 에서 멈춘 것처럼 보여 사용자가 작업이 죽었다고 오해한다.
 */
function patchJobProgress(
  jobs: Job[],
  jobId: string,
  update: (job: Job) => Job,
): Job[] {
  let changed = false;
  const next = jobs.map((job) => {
    if (job.id !== jobId) return job;
    changed = true;
    return update(job);
  });
  return changed ? next : jobs;
}

/** 변형 이벤트에 실린 `mode`(백엔드가 delta/done/error 에 함께 넣어 준다). */
function eventVariantMode(event: { mode?: VariantMode }): VariantMode | null {
  return event.mode ?? null;
}

/** 저장 풀이 조회 중복 방지용 진행 키 집합(`${fileId}::${no}`). 직렬화 대상 아님. */
const problemSolutionLoading = new Set<string>();

/**
 * 변형 결과 저장 키: 시험지 문항(file_id + problem_no) 단위.
 * 형식은 `lib/variant` 에 하나만 둔다(화면 쪽 판정 함수가 같은 키를 읽는다).
 */
function variantKey(fileId: string, no: number): string {
  return variantCacheKey(fileId, no);
}

/**
 * 배경 로딩(기존 풀이 / 대화 이력) 유효성 토큰.
 *
 * 파일을 고른 직후 사용자가 바로 질문하거나 풀이를 시작하면, 뒤늦게 도착한
 * 이력 응답이 방금 만든 상태를 덮어써 버린다. 사용자가 상태를 바꾸는 액션에서
 * 이 값을 올려 늦게 온 응답을 버린다.
 */
let dataEpoch = 0;

const emptySolve: SolveProgress = {
  running: false,
  total: 0,
  doneCount: 0,
  currentNo: null,
  partial: false,
  error: null,
  aborted: false,
};

const emptyTotals: SessionTotals = {
  usage: null,
  usd: 0,
  krw: 0,
  billedCalls: 0,
  subscriptionCalls: 0,
};

function readPrefs(): UiPrefs {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(UI_PREFS_STORAGE);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as UiPrefs;
  } catch {
    return {};
  }
}

function writePrefs(prefs: UiPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(UI_PREFS_STORAGE, JSON.stringify(prefs));
  } catch {
    // 저장 실패는 무시(프라이빗 모드 등).
  }
}

/**
 * prefs 를 **머지**로 저장한다. 항상 기존 값을 읽어 부분 필드만 갱신하므로
 * 서로 다른 저장부(model/effort/provider/rightWidth/lastFileId/lastConversationId)가
 * 서로를 지우지 않는다.
 */
function persistPrefs(partial: UiPrefs): void {
  writePrefs({ ...readPrefs(), ...partial });
}

/**
 * 구독을 쓸 수 없는 환경(웹 배포)에서 provider 가 'subscription' 으로 남아 있으면
 * 백엔드가 409 를 주고, select 값이 옵션 목록에 없어서 빈칸으로 보인다.
 * 그런 경우에만 'apikey' 로 바꾼다. (available 을 모르면 손대지 않는다.)
 */
function normalizeProvider(
  provider: ProviderChoice,
  subscriptionAvailable: boolean | undefined,
): ProviderChoice {
  if (subscriptionAvailable === false && provider === 'subscription') return 'apikey';
  return provider;
}

function clampWidth(width: number): number {
  return Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, Math.round(width)));
}

function clampLeftWidth(width: number): number {
  return Math.min(LEFT_MAX, Math.max(LEFT_MIN, Math.round(width)));
}

/** 아직 판독하지 않은 문항의 빈 자리. */
function emptyTranscript(no: number): TranscriptEntry {
  return {
    no,
    text: '',
    streamingText: '',
    status: 'idle',
    source: null,
    note: null,
    route: null,
    usage: null,
    cost: null,
    error: null,
    saving: false,
  };
}

function emptyEntry(no: number): SolutionEntry {
  return {
    no,
    text: '',
    streamingText: '',
    status: 'empty',
    usage: null,
    cost: null,
    truncated: false,
    error: null,
    createdAt: null,
  };
}

let entrySeq = 0;

/** 서버 대화 메시지 → 화면 엔트리 매퍼. file_id/problem_no 첨부 컨텍스트를 붙인다. */
function conversationMessageToEntry(message: ConversationMessage): ChatEntry {
  entrySeq += 1;
  return {
    id: `history-${entrySeq}`,
    role: message.role,
    content: message.content,
    streaming: false,
    usage: message.usage ?? null,
    cost: message.cost ?? null,
    error: null,
    createdAt: message.created_at,
    problemNo: message.problem_no,
    fileId: message.file_id,
  };
}

type SetState = (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void;

/** 시스템 안내 메시지를 채팅 목록에 추가한다(오답노트 추가 결과 등). */
function pushSystemMessage(set: SetState, content: string): void {
  entrySeq += 1;
  const entry: ChatEntry = {
    id: `system-${entrySeq}`,
    role: 'system',
    content,
    streaming: false,
    usage: null,
    cost: null,
    error: null,
    createdAt: new Date().toISOString(),
    problemNo: null,
    fileId: null,
  };
  set((state) => ({ messages: [...state.messages, entry] }));
}

export const useWorkspace = create<WorkspaceState>()((set, get) => ({
  env: null,
  envStatus: 'idle',
  envError: null,
  onboardingSkipped: false,
  hasLocalApiKey: false,
  // 비번 요구 환경인지 아직 모른다. loadEnv 가 env.auth_required 로 확정한다.
  accessOk: false,
  authError: null,
  authChecking: false,
  providerConfig: null,

  section: 'exam',
  nodes: [],
  treeStatus: 'idle',
  treeError: null,
  expanded: {},
  focusedNodeId: null,
  pendingOp: null,
  reextracting: null,
  jobs: [],
  cancelingJobIds: [],
  notePicking: false,
  notePicked: [],
  variantPicking: false,
  variantPicked: [],
  variantKind: 'number',

  openKind: 'none',
  selectedFileId: null,
  fileDetail: null,
  fileStatus: 'idle',
  fileError: null,
  selectedProblemNo: null,

  selectedNoteId: null,
  noteDetail: null,
  noteStatus: 'idle',
  noteError: null,
  notePrompt: null,

  conversations: [],
  activeConversationId: null,
  chatTruncatedBefore: 0,

  activeTab: 'pdf',
  focusRequest: null,

  solutions: {},
  solutionsStatus: 'idle',
  solve: emptySolve,
  variants: {},
  transcripts: {},
  problemSolutions: {},

  messages: [],
  chatStatus: 'idle',
  chatSending: false,

  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  // 기본은 구독이다. API 키는 사용량만큼 과금되므로 사용자가 명시적으로 고르게 한다.
  // 구독을 못 쓰는 환경(웹)에서는 loadEnv/hydratePrefs 가 'apikey' 로 정규화한다.
  provider: 'subscription',

  totals: emptyTotals,
  usageSummary: null,

  rightWidth: RIGHT_DEFAULT,
  leftWidth: LEFT_DEFAULT,
  leftCollapsed: false,
  rightCollapsed: false,
  toast: null,

  hydratePrefs() {
    const prefs = readPrefs();
    set((state) => ({
      model: prefs.model ?? state.model,
      effort: prefs.effort ?? state.effort,
      // env 를 아직 못 받았으면(대부분의 경우) 여기서는 그대로 두고, 직후 loadEnv 가 정규화한다.
      provider: normalizeProvider(
        prefs.provider ?? state.provider,
        state.env?.subscription.available,
      ),
      rightWidth: prefs.rightWidth ? clampWidth(prefs.rightWidth) : state.rightWidth,
      leftWidth: prefs.leftWidth ? clampLeftWidth(prefs.leftWidth) : state.leftWidth,
      leftCollapsed: prefs.leftCollapsed ?? state.leftCollapsed,
      rightCollapsed: prefs.rightCollapsed ?? state.rightCollapsed,
      hasLocalApiKey: readStoredApiKey() != null,
    }));
  },

  async loadEnv() {
    set({ envStatus: 'loading', envError: null });
    try {
      const env = await api.getEnv();
      const config = resolveProviderConfig(env);
      set((state) => {
        // provider: 저장값이 이 환경에서 쓸 수 있으면 유지, 아니면 config 기본값.
        // 최초 로드(idle)면 무조건 서버 기본값을 따른다(default_provider 존중).
        const wasInitial = state.envStatus === 'idle' || state.envStatus === 'loading';
        let provider: ProviderChoice = state.provider;
        if (wasInitial) {
          provider = config.defaultProvider;
        } else if (!isProviderAvailable(config, provider)) {
          provider = config.defaultProvider;
        }
        // 폴백(구버전)에서는 subscription 정규화도 적용.
        if (!config.hasProvidersShape) {
          provider = normalizeProvider(provider, env.subscription.available);
        }

        // 모델: 현재 provider 의 모델 목록에 저장값이 있으면 유지, 없으면 그 provider 기본.
        const providerModels =
          config.options.find((option) => option.id === provider)?.models ?? [];
        const modelKnown = providerModels.some((model) => model.id === state.model);
        const model = modelKnown
          ? state.model
          : (defaultModelForProvider(config, provider) ?? env.models[0]?.id ?? DEFAULT_MODEL);

        return {
          env,
          providerConfig: config,
          envStatus: 'ready',
          model,
          provider,
          // 비번 미요구면 항상 통과. 요구 환경이면 저장 비번이 있는 동안 낙관적으로 통과시키고
          // 유효성은 첫 요청의 401 로 판정한다(틀리면 handleUnauthorized 가 다시 잠근다).
          // 이미 게이트를 통과(accessOk)했으면 그 상태를 유지한다(env 재조회로 로그아웃되지 않게).
          accessOk: state.accessOk || initialAccessOk(env),
        };
      });
    } catch (error) {
      set({ envStatus: 'error', envError: toUserMessage(error) });
    }
  },

  async login(password: string) {
    const trimmed = password.trim();
    if (trimmed === '' || get().authChecking) return false;
    set({ authChecking: true, authError: null });
    try {
      await api.login(trimmed);
      writeStoredPassword(trimmed);
      set({ accessOk: true, authError: null, authChecking: false });
      // 게이트를 넘었으니 트리와 대화 목록을 (다시) 불러온다.
      void get().loadTree();
      void get().bootstrapConversations();
      return true;
    } catch (error) {
      // 401 = 비번이 틀림. 그 외(네트워크 등)는 원인 메시지를 그대로 보여준다.
      const wrong = isUnauthorizedError(error);
      set({
        authChecking: false,
        authError: wrong ? '비밀번호가 올바르지 않습니다.' : toUserMessage(error),
      });
      return false;
    }
  },

  logout() {
    writeStoredPassword(null);
    // 복원 대상도 비운다(다음 로그인 때 이전 파일/대화를 자동으로 열지 않게).
    persistPrefs({ lastFileId: null, lastConversationId: null });
    // 게이트 뒤에 남은 민감한 화면 상태를 비운다. (게이트는 전체화면으로 덮이지만 안전하게)
    set({
      accessOk: false,
      authError: null,
      authChecking: false,
      nodes: [],
      treeStatus: 'idle',
      openKind: 'none',
      selectedFileId: null,
      fileDetail: null,
      selectedNoteId: null,
      noteDetail: null,
      messages: [],
      conversations: [],
      activeConversationId: null,
      chatTruncatedBefore: 0,
      solutions: {},
      variants: {},
      transcripts: {},
      problemSolutions: {},
    });
  },

  handleUnauthorized() {
    // 이미 잠겨 있으면(로그인 화면) 중복 처리하지 않는다.
    if (!get().accessOk) return;
    set({
      accessOk: false,
      authError: '세션이 만료되었거나 비밀번호가 변경되었습니다. 다시 로그인해 주세요.',
      authChecking: false,
    });
  },

  async saveApiKey(key: string) {
    try {
      await api.setApiKey(key);
      set({ hasLocalApiKey: true });
      await get().loadEnv();
      get().showToast({ kind: 'success', message: 'API 키를 저장했습니다.' });
      return true;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return false;
    }
  },

  async clearApiKey() {
    try {
      await api.deleteApiKey();
      set({ hasLocalApiKey: false });
      await get().loadEnv();
      get().showToast({ kind: 'info', message: 'API 키를 삭제했습니다.' });
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    }
  },

  skipOnboarding() {
    set({ onboardingSkipped: true });
  },

  async setSection(section: Section) {
    if (get().section === section) return;
    set({ section, nodes: [], treeStatus: 'loading', focusedNodeId: null });
    await get().loadTree(section);
  },

  async loadTree(section?: Section) {
    const target = section ?? get().section;
    set((state) => ({
      treeStatus: state.nodes.length > 0 ? state.treeStatus : 'loading',
      treeError: null,
    }));
    try {
      const { nodes } = await api.getTree(target);
      // 그 사이 섹션이 바뀌었으면 버린다.
      if (get().section !== target) return;
      // 폴더는 접힌 채로 시작한다(요청: "닫혀 있는 상태가 디폴트").
      // 예전에는 여기서 루트 폴더를 자동으로 펼쳤지만, 폴더가 늘수록 첫 화면이
      // 길어져 오히려 찾기 어려웠다. 반대로 "방금 내가 만든 것" 은 보여야 하므로
      // 생성·업로드·이동 액션의 부모 펼침(아래 createFolder 등)은 그대로 둔다.
      // `expanded` 를 건드리지 않으므로 새로 고침해도 사용자가 펼쳐 둔 폴더는 유지된다.
      set({ nodes, treeStatus: 'ready' });
      // 시험지 트리를 처음 그린 직후, 마지막으로 보던 파일/스레드를 자동 복원한다.
      if (target === 'exam') void get().restoreLastOpen();
    } catch (error) {
      if (get().section !== target) return;
      set({ treeStatus: 'error', treeError: toUserMessage(error) });
    }
  },

  async restoreLastOpen() {
    // 이미 파일/노트를 열었으면(사용자가 먼저 클릭) 덮어쓰지 않는다(경합 방지).
    if (get().selectedFileId != null || get().openKind !== 'none') return;
    const prefs = readPrefs();
    const fileId = prefs.lastFileId ?? null;
    if (!fileId) return;

    // 트리에 시험지 파일로 실제 존재해야 연다. 삭제됐으면 stale prefs 를 정리하고 중단.
    const node = get().nodes.find((candidate) => candidate.id === fileId);
    if (!node || node.type !== 'file' || (node.section ?? 'exam') !== 'exam') {
      persistPrefs({ lastFileId: null });
      return;
    }

    await get().selectFile(fileId);
  },

  focusNode(id: string | null) {
    set({ focusedNodeId: id });
  },

  toggleExpanded(id: string) {
    set((state) => ({ expanded: { ...state.expanded, [id]: !state.expanded[id] } }));
  },

  setExpanded(id: string, value: boolean) {
    set((state) => ({ expanded: { ...state.expanded, [id]: value } }));
  },

  collapseAll() {
    // 값을 false 로 덮지 않고 통째로 비운다: TreeRow 는 `expanded[id] === true` 일 때만
    // 펼치므로 "없음" 과 "false" 가 같은 뜻이고, 빈 객체가 초기 상태와도 일치한다.
    // 섹션 구분 없이 비우지만 다른 섹션 트리는 어차피 다시 그릴 때 접힌 채로 시작한다.
    set({ expanded: {} });
  },

  async createFolder(name: string, parentId: string | null) {
    set({ pendingOp: '폴더를 만들고 있습니다…' });
    try {
      const node = await api.createFolder(name, parentId, get().section);
      set((state) => ({
        nodes: [...state.nodes, node],
        expanded: parentId ? { ...state.expanded, [parentId]: true } : state.expanded,
      }));
      return true;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return false;
    } finally {
      set({ pendingOp: null });
    }
  },

  async createNote(name: string, parentId: string | null) {
    set({ pendingOp: '오답노트를 만들고 있습니다…' });
    try {
      const node = await api.createNote(name, parentId);
      // 노트는 note 섹션에서만 보인다. 현재 note 섹션이면 트리에 반영.
      if (get().section === 'note') {
        set((state) => ({
          nodes: [...state.nodes, node],
          expanded: parentId ? { ...state.expanded, [parentId]: true } : state.expanded,
        }));
      }
      return true;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return false;
    } finally {
      set({ pendingOp: null });
    }
  },

  async renameNode(id: string, name: string) {
    set({ pendingOp: '이름을 바꾸고 있습니다…' });
    try {
      const node = await api.updateNode(id, { name });
      set((state) => ({
        nodes: state.nodes.map((candidate) => (candidate.id === id ? node : candidate)),
        fileDetail:
          state.fileDetail && state.fileDetail.node.id === id
            ? { ...state.fileDetail, node }
            : state.fileDetail,
      }));
      return true;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return false;
    } finally {
      set({ pendingOp: null });
    }
  },

  async moveNode(id: string, parentId: string | null) {
    const { nodes } = get();
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) return false;
    if (node.parent_id === parentId) return false;
    if (parentId === id) {
      get().showToast({ kind: 'error', message: '자기 자신 안으로는 옮길 수 없습니다.' });
      return false;
    }
    if (parentId != null && isDescendantOf(nodes, id, parentId)) {
      get().showToast({ kind: 'error', message: '하위 폴더 안으로는 옮길 수 없습니다.' });
      return false;
    }

    set({ pendingOp: '옮기고 있습니다…' });
    try {
      const updated = await api.updateNode(id, { parent_id: parentId });
      set((state) => ({
        nodes: state.nodes.map((candidate) => (candidate.id === id ? updated : candidate)),
        expanded: parentId ? { ...state.expanded, [parentId]: true } : state.expanded,
      }));
      return true;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return false;
    } finally {
      set({ pendingOp: null });
    }
  },

  async moveNodes(ids: string[], parentId: string | null) {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return;

    const failures: string[] = [];
    let moved = 0;
    set({ pendingOp: '옮기고 있습니다…' });
    try {
      for (const id of unique) {
        const { nodes } = get();
        const node = nodes.find((candidate) => candidate.id === id);
        // 사라졌거나 이미 그 폴더에 있는 노드는 조용히 건너뛴다(빈 요청 방지).
        if (!node || node.parent_id === parentId) continue;
        if (parentId === id) {
          failures.push(`${node.name}: 자기 자신 안으로는 옮길 수 없습니다.`);
          continue;
        }
        // 순환은 서버도 막지만(cycle_detected), 왕복 없이 먼저 걸러 이유를 정확히 알린다.
        if (parentId != null && isDescendantOf(nodes, id, parentId)) {
          failures.push(`${node.name}: 하위 폴더 안으로는 옮길 수 없습니다.`);
          continue;
        }
        try {
          const updated = await api.updateNode(id, { parent_id: parentId });
          set((state) => ({
            nodes: state.nodes.map((candidate) => (candidate.id === id ? updated : candidate)),
          }));
          moved += 1;
        } catch (error) {
          failures.push(`${node.name}: ${toUserMessage(error)}`);
        }
      }
    } finally {
      set({ pendingOp: null });
    }

    if (moved > 0) {
      if (parentId != null) {
        set((state) => ({ expanded: { ...state.expanded, [parentId]: true } }));
      }
      // 옮긴 뒤 정렬·부모 관계를 서버 기준으로 맞춘다. 여기서 딱 한 번만 읽는다.
      await get().loadTree();
    }

    if (failures.length > 0) {
      get().showToast({
        kind: 'error',
        message: `${failures.length}개를 옮기지 못했습니다.`,
        hint: failures.join(' / '),
      });
      return;
    }
    if (moved > 1) {
      get().showToast({ kind: 'success', message: `${moved}개를 옮겼습니다.` });
    }
  },

  async deleteNode(id: string) {
    set({ pendingOp: '삭제하고 있습니다…' });
    try {
      await api.deleteNode(id);
      const { nodes, selectedFileId } = get();
      const removed = new Set<string>([id]);
      for (const node of nodes) {
        if (isDescendantOf(nodes, id, node.id)) removed.add(node.id);
      }
      set((state) => ({
        nodes: state.nodes.filter((node) => !removed.has(node.id)),
        // 지워진 노드에 포커스가 남으면 업로드 대상이 유령 폴더가 된다.
        focusedNodeId:
          state.focusedNodeId && removed.has(state.focusedNodeId) ? null : state.focusedNodeId,
      }));
      if (selectedFileId && removed.has(selectedFileId)) {
        set({
          openKind: 'none',
          selectedFileId: null,
          fileDetail: null,
          fileStatus: 'idle',
          selectedProblemNo: null,
          solutions: {},
          solve: emptySolve,
        });
        // 삭제된 파일을 복원하지 않도록 stale prefs 를 정리한다.
        persistPrefs({ lastFileId: null });
      }
      const { selectedNoteId } = get();
      if (selectedNoteId && removed.has(selectedNoteId)) {
        set({ openKind: 'none', selectedNoteId: null, noteDetail: null, noteStatus: 'idle' });
      }
      return true;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return false;
    } finally {
      set({ pendingOp: null });
    }
  },

  async deleteNodes(ids: string[]) {
    const unique = Array.from(new Set(ids));
    if (unique.length === 0) return;

    // 상위와 하위가 함께 선택된 경우 상위만 부른다. 하위는 서버가 함께 지우므로
    // 따로 부르면 404 가 되고 실패 토스트만 늘어난다.
    const before = get().nodes;
    const targets = unique.filter(
      (id) => !unique.some((other) => other !== id && isDescendantOf(before, other, id)),
    );

    const failures: string[] = [];
    const removed = new Set<string>();
    let deleted = 0;

    set({ pendingOp: '삭제하고 있습니다…' });
    try {
      for (const id of targets) {
        const current = get().nodes;
        const node = current.find((candidate) => candidate.id === id);
        // 이미 사라진 노드는 조용히 건너뛴다(선택에 낡은 id 가 남은 경우).
        if (!node) continue;
        try {
          await api.deleteNode(id);
          deleted += 1;
          removed.add(id);
          for (const candidate of current) {
            if (isDescendantOf(current, id, candidate.id)) removed.add(candidate.id);
          }
          set((state) => ({ nodes: state.nodes.filter((candidate) => !removed.has(candidate.id)) }));
        } catch (error) {
          failures.push(`${node.name}: ${toUserMessage(error)}`);
        }
      }
    } finally {
      set({ pendingOp: null });
    }

    if (removed.size > 0) {
      // 지워진 노드에 포커스가 남으면 업로드 대상이 유령 폴더가 된다.
      set((state) => ({
        focusedNodeId:
          state.focusedNodeId && removed.has(state.focusedNodeId) ? null : state.focusedNodeId,
      }));
      const { selectedFileId, selectedNoteId } = get();
      if (selectedFileId && removed.has(selectedFileId)) {
        set({
          openKind: 'none',
          selectedFileId: null,
          fileDetail: null,
          fileStatus: 'idle',
          selectedProblemNo: null,
          solutions: {},
          solve: emptySolve,
        });
        // 삭제된 파일을 복원하지 않도록 stale prefs 를 정리한다.
        persistPrefs({ lastFileId: null });
      }
      if (selectedNoteId && removed.has(selectedNoteId)) {
        set({ openKind: 'none', selectedNoteId: null, noteDetail: null, noteStatus: 'idle' });
      }
      // 정렬·부모 관계를 서버 기준으로 맞춘다. 여기서 딱 한 번만 읽는다.
      await get().loadTree();
    }

    if (failures.length > 0) {
      get().showToast({
        kind: 'error',
        message: `${failures.length}개를 삭제하지 못했습니다.`,
        hint: failures.join(' / '),
      });
      return;
    }
    if (deleted > 1) {
      get().showToast({ kind: 'success', message: `${deleted}개를 삭제했습니다.` });
    }
  },

  async uploadFiles(files: File[], parentId: string | null) {
    if (files.length === 0) return;
    // 어디로 올라가는지 진행 중에도 밝힌다(루트로 새는 버그가 실제로 있었다).
    const targetLabel = uploadTargetLabel(get().nodes, parentId);
    set({
      pendingOp: `${targetLabel} 에 업로드 중… (${files.length}개, 문제 추출까지 시간이 걸립니다)`,
    });
    let lastId: string | null = null;
    try {
      for (const file of files) {
        const node = await api.uploadFile(file, parentId);
        lastId = node.id;
        set((state) => ({
          nodes: [...state.nodes, node],
          expanded: parentId ? { ...state.expanded, [parentId]: true } : state.expanded,
        }));
      }
      get().showToast({
        kind: 'success',
        message: `${targetLabel} 에 ${files.length}개 업로드했습니다.`,
        // 답안지가 섞인 PDF 를 올려 놓고 오인식을 버그로 신고하는 일이 잦다.
        hint: UPLOAD_NOTICE,
      });
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    } finally {
      set({ pendingOp: null });
    }
    if (lastId) await get().selectFile(lastId);
  },

  async reextractFile(id: string) {
    if (get().reextracting) return;
    set({ reextracting: id, pendingOp: '문제를 다시 추출하는 중… (AI 호출 없음)' });
    try {
      const result = await api.reextractFile(id);
      // 이미 다른 파일로 옮겨갔으면 화면 상태는 건드리지 않는다(트리만 갱신).
      const stillOpen = get().selectedFileId === id && get().openKind === 'exam';
      const solutions: Record<number, SolutionEntry> = {};
      for (const problem of result.problems) solutions[problem.no] = emptyEntry(problem.no);
      set((state) => ({
        nodes: state.nodes.map((node) => (node.id === id ? result.node : node)),
        // 판독본도 서버에서 지워졌다(문항 번호가 바뀔 수 있어 `reextract` 가 함께
        // 버린다). 캐시를 남기면 서버에 없는 판독본으로 배지·카운트·텍스트
        // 내보내기 활성화가 거짓을 말한다. 이 파일이 열려 있는지와 무관하다 —
        // 캐시 키가 file_id 라 나중에 다시 열어도 그대로 남는다.
        transcripts: dropFileTranscripts(state.transcripts, id),
        ...(stillOpen
          ? {
              // 재추출 사유도 화면까지 실어 보낸다. 0문항이면 [풀이] 탭의 빈 상태가
              // 이 문장을 그대로 띄운다(토스트는 사라지지만 화면은 남는다).
              fileDetail: {
                node: result.node,
                problems: result.problems,
                extract_error: result.extract_error,
              },
              fileStatus: 'ready' as const,
              fileError: null,
              // 풀이는 서버에서 지워졌다. 화면 캐시도 함께 비운다.
              solutions,
              solutionsStatus: 'ready' as const,
              selectedProblemNo: null,
              solve: emptySolve,
            }
          : {}),
      }));

      if (result.extract_error) {
        get().showToast({ kind: 'error', message: result.extract_error });
        return;
      }
      const removed =
        result.deleted_solutions > 0
          ? ` (기존 풀이 ${result.deleted_solutions}건은 지워졌습니다)`
          : '';
      get().showToast({
        kind: 'success',
        message: `${result.problems.length}문항을 다시 추출했습니다.${removed}`,
      });
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    } finally {
      set({ reextracting: null, pendingOp: null });
    }
  },

  async openNode(id: string) {
    // 트리에서 파일형 노드를 열 때 섹션에 따라 분기.
    const node = get().nodes.find((candidate) => candidate.id === id);
    const section = node?.section ?? get().section;
    if (section === 'note') {
      await get().selectNote(id);
    } else {
      await get().selectFile(id);
    }
  },

  async selectFile(id: string) {
    if (get().openKind === 'exam' && get().selectedFileId === id) return;
    // 진행 중인 풀이는 **취소하지 않는다.** 작업은 서버 큐에서 돌고 있어 다른
    // 시험지를 보거나 브라우저를 닫아도 계속된다. 진행 상황은 상단 배너가 보여준다.
    const epoch = ++dataEpoch;

    set({
      openKind: 'exam',
      selectedFileId: id,
      selectedNoteId: null,
      noteDetail: null,
      noteStatus: 'idle',
      fileDetail: null,
      fileStatus: 'loading',
      fileError: null,
      selectedProblemNo: null,
      solutions: {},
      solutionsStatus: 'loading',
      solve: emptySolve,
      focusRequest: null,
      // 다른 시험지를 열면 담기·변형 선택을 버린다(엉뚱한 문항을 담거나
      // 엉뚱한 문항의 변형을 만드는 사고 방지).
      notePicking: false,
      notePicked: [],
      variantPicking: false,
      variantPicked: [],
    });
    // 새로고침 복원용: 마지막으로 연 파일을 기록한다.
    persistPrefs({ lastFileId: id });

    try {
      const detail = await api.getFile(id);
      if (get().selectedFileId !== id || dataEpoch !== epoch) return;
      const solutions: Record<number, SolutionEntry> = {};
      for (const problem of detail.problems) solutions[problem.no] = emptyEntry(problem.no);
      set({ fileDetail: detail, fileStatus: 'ready', solutions });
    } catch (error) {
      if (get().selectedFileId !== id) return;
      set({ fileStatus: 'error', fileError: toUserMessage(error), solutionsStatus: 'error' });
      return;
    }

    // 기존 풀이는 실패해도 나머지 화면은 살린다.
    void (async () => {
      try {
        const { solutions } = await api.getSolutions(id);
        if (get().selectedFileId !== id || dataEpoch !== epoch) return;
        set((state) => {
          const next = { ...state.solutions };
          for (const solution of solutions) {
            next[solution.no] = {
              no: solution.no,
              text: solution.solution,
              streamingText: '',
              status: 'done',
              usage: solution.usage,
              cost: solution.cost,
              truncated: solution.truncated ?? false,
              error: null,
              createdAt: solution.created_at,
            };
          }
          return { solutions: next, solutionsStatus: 'ready' };
        });
      } catch {
        if (get().selectedFileId !== id || dataEpoch !== epoch) return;
        set({ solutionsStatus: 'error' });
      }
    })();

    // 이 시험지에 진행 중인 풀이 작업이 있으면 화면 상태를 되살린다.
    // (파일을 옮겼다 돌아오면 solve 가 초기화되어 "풀고 있다" 표시가 사라졌다.)
    void (async () => {
      await get().loadJobs();
      if (get().selectedFileId !== id || dataEpoch !== epoch) return;
      const running = get().jobs.find(
        (job) =>
          job.node_id === id &&
          job.kind === 'solve' &&
          (job.status === 'running' || job.status === 'queued'),
      );
      if (!running) return;
      set((state) => ({
        solve: {
          running: true,
          total: running.total,
          doneCount: running.done_count,
          currentNo: running.current_no,
          partial: state.solve.partial,
          error: null,
          aborted: false,
        },
        // 지금 풀고 있는 문항은 '생성 중' 으로 보여준다(다음 델타부터 이어진다).
        solutions:
          running.current_no != null
            ? patchEntry(state.solutions, running.current_no, (entry) => ({
                ...entry,
                status: 'running',
              }))
            : state.solutions,
      }));
    })();

    // 저장된 변형을 스토어에 채운다. 새로고침해도 남고, 이미 만든 변형을 다시
    // 생성해 쿼터를 낭비하지 않는다(캐시는 file_id 로 키를 잡으므로 뒤늦게
    // 도착해도 다른 시험지를 오염시키지 않는다 — epoch 검사가 필요 없다).
    void get().loadVariants(id);
    // 판독본도 같은 이유로 열 때 채운다. 출처 배지·진행 표시·텍스트 내보내기
    // 활성화가 모두 이 캐시를 본다.
    void get().loadTranscripts(id);
  },

  async selectNote(id: string) {
    if (get().openKind === 'note' && get().selectedNoteId === id) return;

    set({
      openKind: 'note',
      selectedNoteId: id,
      noteDetail: null,
      noteStatus: 'loading',
      noteError: null,
      // 노트를 열면 시험지 컨텍스트는 접는다(대화는 전역이라 유지).
      selectedFileId: null,
      fileDetail: null,
      fileStatus: 'idle',
      selectedProblemNo: null,
    });
    // 노트를 열면 시험지 선택이 해제되므로 파일 복원 대상만 비운다.
    persistPrefs({ lastFileId: null });

    try {
      const detail = await api.getNote(id);
      if (get().selectedNoteId !== id) return;
      set({ noteDetail: detail, noteStatus: 'ready' });
    } catch (error) {
      if (get().selectedNoteId !== id) return;
      set({ noteStatus: 'error', noteError: toUserMessage(error) });
    }
  },

  async refreshNote() {
    const id = get().selectedNoteId;
    if (!id) return;
    try {
      const detail = await api.getNote(id);
      if (get().selectedNoteId !== id) return;
      set({ noteDetail: detail, noteStatus: 'ready' });
    } catch {
      // 새로고침 실패는 조용히 둔다(기존 표시 유지).
    }
  },

  async deleteNoteItem(itemId: string) {
    const id = get().selectedNoteId;
    if (!id) return;
    try {
      await api.deleteNoteItem(id, itemId);
      set((state) => ({
        noteDetail: state.noteDetail
          ? {
              ...state.noteDetail,
              items: state.noteDetail.items.filter((item) => item.id !== itemId),
            }
          : state.noteDetail,
      }));
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    }
  },

  selectProblem(no: number | null) {
    set({ selectedProblemNo: no });
  },

  focusProblem(no: number) {
    const detail = get().fileDetail;
    const problem = detail?.problems.find((candidate) => candidate.no === no);
    // 문제 클릭 = 그 문제를 대화 첨부 컨텍스트로 선택(전역 대화에 file_id+problem_no 로 실린다).
    set((state) => ({
      selectedProblemNo: no,
      focusRequest: problem
        ? { no, page: problem.page, token: (state.focusRequest?.token ?? 0) + 1 }
        : state.focusRequest,
    }));
  },

  async loadConversations() {
    try {
      const { conversations } = await api.getConversations();
      set({ conversations });
    } catch {
      // 목록 실패는 화면을 막지 않는다.
    }
  },

  async bootstrapConversations() {
    await get().loadConversations();
    const prefs = readPrefs();
    const lastId = prefs.lastConversationId ?? null;
    const list = get().conversations;
    // 마지막으로 보던 대화가 아직 남아 있으면 그걸 복원한다.
    // (없거나 삭제됐으면 새 대화 초안(none) 상태로 둔다.)
    if (lastId && list.some((conversation) => conversation.id === lastId)) {
      await get().openConversation(lastId);
    } else if (lastId) {
      persistPrefs({ lastConversationId: null });
    }
  },

  async openConversation(id: string) {
    if (get().activeConversationId === id && get().chatStatus === 'ready') return;
    get().abortChat();
    const epoch = ++dataEpoch;
    set({
      activeConversationId: id,
      messages: [],
      chatStatus: 'loading',
      chatTruncatedBefore: 0,
    });
    persistPrefs({ lastConversationId: id });
    try {
      const { messages } = await api.getConversationMessages(id);
      if (get().activeConversationId !== id || dataEpoch !== epoch) return;
      set({ messages: messages.map(conversationMessageToEntry), chatStatus: 'ready' });
    } catch {
      if (get().activeConversationId !== id || dataEpoch !== epoch) return;
      set({ chatStatus: 'error' });
    }
  },

  newConversation() {
    get().abortChat();
    dataEpoch += 1;
    set({
      activeConversationId: null,
      messages: [],
      chatStatus: 'ready',
      chatTruncatedBefore: 0,
    });
    persistPrefs({ lastConversationId: null });
  },

  async renameConversation(id: string, title: string) {
    const trimmed = title.trim();
    if (trimmed === '') return;
    try {
      const conversation = await api.renameConversation(id, trimmed);
      set((state) => ({
        conversations: state.conversations.map((candidate) =>
          candidate.id === id ? conversation : candidate,
        ),
      }));
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    }
  },

  async deleteConversation(id: string) {
    try {
      await api.deleteConversation(id);
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return;
    }
    const wasActive = get().activeConversationId === id;
    set((state) => ({
      conversations: state.conversations.filter((candidate) => candidate.id !== id),
    }));
    if (!wasActive) return;
    // 활성 대화를 지웠으면 최신 대화로 폴백(없으면 새 대화 초안).
    const latest = get().conversations[0];
    if (latest) await get().openConversation(latest.id);
    else get().newConversation();
  },

  async saveSolutionFromMessage(messageId: string) {
    const message = get().messages.find((entry) => entry.id === messageId);
    if (
      !message ||
      message.role !== 'assistant' ||
      message.fileId == null ||
      message.problemNo == null ||
      message.content.trim() === '' ||
      message.savingSolution
    ) {
      return;
    }
    const fileId = message.fileId;
    const no = message.problemNo;
    set((state) => ({
      messages: state.messages.map((entry) =>
        entry.id === messageId ? { ...entry, savingSolution: true } : entry,
      ),
    }));
    try {
      const saved = await api.saveSolutionContent(fileId, no, message.content, message.usage, 'chat');
      // 지금 그 시험지가 열려 있으면 풀이 탭에 즉시 반영한다.
      if (get().selectedFileId === fileId) {
        set((state) => ({
          solutions: {
            ...state.solutions,
            [no]: {
              no,
              text: saved.solution,
              streamingText: '',
              status: 'done',
              usage: saved.usage,
              cost: saved.cost,
              truncated: saved.truncated ?? false,
              error: null,
              createdAt: saved.created_at,
            },
          },
        }));
      }
      set((state) => ({
        messages: state.messages.map((entry) =>
          entry.id === messageId
            ? { ...entry, savingSolution: false, savedAsSolution: true }
            : entry,
        ),
      }));
      get().showToast({ kind: 'success', message: `${no}번 풀이로 저장했습니다.` });
    } catch (error) {
      set((state) => ({
        messages: state.messages.map((entry) =>
          entry.id === messageId ? { ...entry, savingSolution: false } : entry,
        ),
      }));
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    }
  },

  async loadUsageSummary() {
    try {
      const summary = await api.getUsageSummary();
      set({ usageSummary: summary });
    } catch {
      // 신규 엔드포인트(미배포)일 수 있다. 조용히 무시하고 세션 값만 보여준다.
    }
  },

  async addProblemsToNote(
    noteId: string,
    sourceNodeId: string,
    problemNumbers: number[],
    memo: string | null = null,
  ) {
    if (problemNumbers.length === 0) return false;
    try {
      const result = await api.addNoteItems(noteId, sourceNodeId, problemNumbers, memo);
      // 지금 그 노트를 보고 있으면 즉시 갱신.
      if (get().selectedNoteId === noteId) await get().refreshNote();
      const addedText = result.added.length > 0 ? `${result.added.join(', ')}번` : '없음';
      const skippedText = result.skipped.length > 0 ? `${result.skipped.join(', ')}번` : '없음';
      get().showToast({
        kind: 'success',
        message: `오답노트에 추가: ${addedText} (이미 있던 것: ${skippedText})`,
      });
      return true;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return false;
    }
  },

  async addProblemsToNotes(
    noteIds: string[],
    sourceNodeId: string,
    problemNumbers: number[],
    memo: string | null = null,
  ) {
    if (noteIds.length === 0 || problemNumbers.length === 0) return false;

    let addedTotal = 0;
    let skippedTotal = 0;
    const failed: string[] = [];
    let firstError: string | null = null;

    // 순차로 부른다. 같은 SQLite 를 동시에 건드리지 않고, 실패 원인을 노트 단위로
    // 분간하기 위해서다.
    for (const noteId of noteIds) {
      try {
        const result = await api.addNoteItems(noteId, sourceNodeId, problemNumbers, memo);
        addedTotal += result.added.length;
        skippedTotal += result.skipped.length;
      } catch (error) {
        const name = get().nodes.find((node) => node.id === noteId)?.name ?? noteId;
        failed.push(name);
        firstError = firstError ?? toUserMessage(error);
      }
    }

    // 지금 보고 있는 노트가 대상에 있으면 즉시 갱신한다.
    const openNote = get().selectedNoteId;
    if (openNote && noteIds.includes(openNote)) await get().refreshNote();

    const noteCount = noteIds.length - failed.length;
    if (failed.length === noteIds.length) {
      get().showToast({ kind: 'error', message: firstError ?? '오답노트에 담지 못했습니다.' });
      return false;
    }
    if (addedTotal === 0 && skippedTotal > 0) {
      get().showToast({ kind: 'info', message: '이미 모두 담겨 있습니다.' });
      return true;
    }

    const problems = `${problemNumbers.length}개 문항`;
    const notes = noteCount === 1 ? '오답노트에' : `${noteCount}개 오답노트에`;
    const skipped = skippedTotal > 0 ? ` (이미 있던 ${skippedTotal}건은 건너뛰었습니다)` : '';
    if (failed.length > 0) {
      get().showToast({
        kind: 'error',
        message: `${problems}을 ${notes} 담았습니다.${skipped} '${failed.join(', ')}' 는 실패했습니다.`,
      });
      return true;
    }
    get().showToast({
      kind: 'success',
      message: `${problems}을 ${notes} 담았습니다.${skipped}`,
    });
    return true;
  },

  async confirmNotePrompt() {
    const prompt = get().notePrompt;
    if (!prompt) return;
    set({ notePrompt: null });
    // 노트를 만들고(루트에) 거기에 추가한다.
    try {
      const node = await api.createNote(prompt.noteName, null);
      if (get().section === 'note') {
        set((state) => ({ nodes: [...state.nodes, node] }));
      }
      const ok = await get().addProblemsToNote(node.id, prompt.sourceNodeId, prompt.problemNumbers);
      const summary = ok
        ? `"${prompt.noteName}" 오답노트를 만들고 ${prompt.problemNumbers.join(', ')}번을 담았습니다.`
        : `"${prompt.noteName}" 오답노트를 만들었지만 항목 추가에 실패했습니다.`;
      pushSystemMessage(set, summary);
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    }
  },

  cancelNotePrompt() {
    const prompt = get().notePrompt;
    set({ notePrompt: null });
    if (prompt) {
      pushSystemMessage(set, `"${prompt.noteName}" 오답노트 만들기를 취소했습니다.`);
    }
  },

  setActiveTab(tab: CenterTab) {
    set({ activeTab: tab });
  },

  async startSolve(problemNumbers: number[] | null, opts = {}) {
    const { force = false } = opts;
    const selectedFileId = get().selectedFileId;
    if (!selectedFileId) {
      get().showToast({ kind: 'info', message: '먼저 왼쪽에서 시험지 파일을 선택하세요.' });
      return;
    }

    const { model, effort, provider } = get();
    // 작업이 실제로 만들어진 뒤에 화면을 초기화한다. 먼저 비우면 "이미 다 풀렸다"
    // 는 이유로 거절당했을 때 멀쩡한 풀이가 화면에서 사라진다.
    let created;
    try {
      created = await api.createJob({
        kind: 'solve',
        node_id: selectedFileId,
        problem_numbers: problemNumbers,
        force,
        provider,
        model,
        effort,
      });
    } catch (error) {
      const message = toUserMessage(error);
      set((state) => ({ solve: { ...state.solve, running: false, error: null } }));
      get().showToast({ kind: 'info', message });
      return;
    }

    set((state) => ({
      activeTab: 'solutions',
      solve: {
        running: true,
        total: created.job.total,
        doneCount: 0,
        currentNo: null,
        partial: problemNumbers != null,
        error: null,
        aborted: false,
      },
      // 서버가 고른 대상만 초기화한다(이미 푼 문항은 건드리지 않는다).
      solutions: resetTargets(state.solutions, problemNumbers),
    }));
    await get().loadJobs();
    void watchJob(created.job);
  },

  startNotePicking() {
    // 이전 선택을 반드시 버린다. 남기면 담기 모달을 닫기만 했을 때 그 선택이
    // 다음 담기에 딸려가 엉뚱한 문항이 노트에 들어간다.
    // 변형 모드는 같은 체크박스를 쓰므로 함께 끈다(체크 하나에 뜻은 하나).
    set({ notePicking: true, notePicked: [], variantPicking: false, variantPicked: [] });
  },

  stopNotePicking() {
    set({ notePicking: false, notePicked: [] });
  },

  toggleNotePick(no: number) {
    set((state) => ({
      notePicked: state.notePicked.includes(no)
        ? state.notePicked.filter((item) => item !== no)
        : [...state.notePicked, no].sort((a, b) => a - b),
    }));
  },

  setNotePicked(numbers: number[]) {
    set({ notePicked: [...numbers].sort((a, b) => a - b) });
  },

  startVariantPicking() {
    // 담기 모드와 같은 규칙: 이전 선택을 버리고 시작한다(엉뚱한 문항 방지).
    set({ variantPicking: true, variantPicked: [], notePicking: false, notePicked: [] });
  },

  stopVariantPicking() {
    set({ variantPicking: false, variantPicked: [] });
  },

  toggleVariantPick(no: number) {
    set((state) => ({
      variantPicked: state.variantPicked.includes(no)
        ? state.variantPicked.filter((item) => item !== no)
        : [...state.variantPicked, no].sort((a, b) => a - b),
    }));
  },

  setVariantPicked(numbers: number[]) {
    set({ variantPicked: [...numbers].sort((a, b) => a - b) });
  },

  setVariantKind(kind: VariantPickKind) {
    set({ variantKind: kind });
  },

  async startVariantBatch(opts = {}) {
    const { force = false } = opts;
    const { selectedFileId, variantPicked, variantKind, model, effort, provider } = get();
    if (!selectedFileId) {
      get().showToast({ kind: 'info', message: '먼저 왼쪽에서 시험지 파일을 선택하세요.' });
      return;
    }
    if (variantPicked.length === 0) {
      // 모드는 열어 둔다 — 사용자가 이어서 고르면 된다.
      get().showToast({ kind: 'info', message: '변형을 만들 문항을 먼저 고르세요.' });
      return;
    }

    const modes = variantModesOf(variantKind);
    let created;
    try {
      created = await api.createJob({
        kind: 'variant',
        node_id: selectedFileId,
        problem_numbers: variantPicked,
        modes,
        force,
        provider,
        model,
        effort,
      });
    } catch (error) {
      // "이미 모두 만들어져 있습니다" 같은 거절도 여기로 온다. 선택과 모드를
      // 남겨 둬야 사용자가 "이미 만든 것도 다시 생성" 으로 바로 다시 걸 수 있다.
      // hint 가 빠져나올 방법을 알려주므로 함께 보여준다.
      get().showToast({
        kind: 'info',
        message: toUserMessage(error),
        hint: toUserHint(error),
      });
      return;
    }

    if (created.existing) {
      // 서버가 겹치는 작업을 돌려줬다 = 이번에 고른 문항은 큐에 들어가지 않았다.
      // 자리를 만들면 아무도 채우지 않아 유령 진행 표시가 된다. 사실대로 알린다.
      get().showToast({
        kind: 'info',
        message: '이 시험지의 변형 작업이 이미 진행 중이라 새로 걸지 않았습니다.',
        hint: '진행 중인 작업이 끝난 뒤 다시 눌러 주세요. 진행 상황은 상단 배너에 있습니다.',
      });
      await get().loadJobs();
      void watchJob(created.job);
      return;
    }

    // 진행 이벤트는 (문항, 종류)별 항목을 **갱신**하므로 자리를 먼저 만들어 둔다.
    // 이미 done 인 조합은 서버도 건너뛰므로 그대로 둔다(스트리밍으로 되돌리면
    // 오지 않을 이벤트를 기다리며 영원히 "생성 중" 으로 남는다).
    const seeded: VariantTargetRef[] = [];
    set((state) => {
      let variants = state.variants;
      for (const no of variantPicked) {
        const key = variantKey(selectedFileId, no);
        for (const mode of modes) {
          if (!force && variants[key]?.[mode]?.status === 'done') continue;
          seeded.push({ no, mode });
          variants = setVariant(variants, key, mode, {
            mode,
            text: '',
            streamingText: '',
            status: 'streaming',
            usage: null,
            cost: null,
            error: null,
          });
        }
      }
      return { variants, activeTab: 'solutions' };
    });
    // 중간에 멈추면 이 자리들을 정리해야 한다(watchJob 의 finally).
    rememberVariantTargets(created.job.id, seeded);

    get().stopVariantPicking();
    get().showToast({
      kind: 'success',
      message: `${variantPicked.length}개 문항의 변형을 만들기 시작했습니다.`,
      hint: '화면을 떠나도 계속 진행됩니다. 진행 상황은 상단 배너에서 볼 수 있습니다.',
    });
    await get().loadJobs();
    void watchJob(created.job);
  },

  async cancelJob(jobId: string) {
    if (get().cancelingJobIds.includes(jobId)) return;
    set((state) => ({ cancelingJobIds: [...state.cancelingJobIds, jobId] }));
    try {
      await api.cancelJob(jobId);
    } catch (error) {
      set((state) => ({
        cancelingJobIds: state.cancelingJobIds.filter((id) => id !== jobId),
      }));
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return;
    }
    // **구독을 끊지 않는다.** 서버는 현재 문항을 마친 뒤 멈추므로, 끊어 버리면
    // 실제로 멈춘 시점을 알 수 없어 화면이 멈춘 것처럼 보인다.
    get().showToast({
      kind: 'info',
      message: '중단을 요청했습니다. 지금 풀고 있는 문항을 마치고 멈춥니다.',
    });
    await get().loadJobs();
  },

  async loadJobs() {
    try {
      const { active, recent } = await api.listJobs();
      set({ jobs: [...active, ...recent] });
      // 진행 중인데 아직 구독하지 않은 작업은 지금 구독한다(새로고침 복구).
      for (const job of active) {
        if (!jobSubscriptions.has(job.id)) void watchJob(job);
      }
    } catch {
      // 목록 조회 실패는 조용히 넘긴다(배너가 잠깐 비는 것뿐).
    }
  },

  async loadProblemSolution(fileId: string, no: number) {
    const key = variantKey(fileId, no);
    const existing = get().problemSolutions[key];
    // 이미 조회를 마쳤거나(done/empty) 생성 중(running)이면 다시 조회하지 않는다.
    // error 만 재조회 대상(사용자가 다시 열었을 때 복구 기회를 준다).
    if (existing && existing.status !== 'error') return;
    if (problemSolutionLoading.has(key)) return;
    problemSolutionLoading.add(key);
    try {
      const { solutions } = await api.getSolutions(fileId);
      const found = solutions.find((solution) => solution.no === no);
      set((state) => ({
        problemSolutions: {
          ...state.problemSolutions,
          [key]: found
            ? {
                no,
                text: found.solution,
                streamingText: '',
                status: 'done',
                usage: found.usage,
                cost: found.cost,
                truncated: found.truncated ?? false,
                error: null,
                createdAt: found.created_at,
              }
            : emptyEntry(no),
        },
      }));
    } catch {
      // 조회 실패는 error 로 남겨 재시도 여지를 준다(이미 다른 경로로 채워졌으면 보존).
      set((state) => ({
        problemSolutions: state.problemSolutions[key]
          ? state.problemSolutions
          : {
              ...state.problemSolutions,
              [key]: {
                ...emptyEntry(no),
                status: 'error',
                error: '저장된 풀이를 불러오지 못했습니다.',
              },
            },
      }));
    } finally {
      problemSolutionLoading.delete(key);
    }
  },

  async solveProblem(fileId: string, no: number, opts = {}) {
    const { force = false } = opts;
    const key = variantKey(fileId, no);
    const existing = get().problemSolutions[key];
    // 캐시 규칙: 진행 중이면 no-op, 이미 done 이면 force 일 때만 다시 푼다.
    if (existing?.status === 'running') return;
    if (existing?.status === 'done' && !force) return;

    const { model, effort, provider } = get();
    set((state) => ({
      problemSolutions: {
        ...state.problemSolutions,
        [key]: { ...emptyEntry(no), status: 'running' },
      },
    }));

    try {
      const created = await api.createJob({
        kind: 'solve',
        node_id: fileId,
        problem_numbers: [no],
        force,
        provider,
        model,
        effort,
      });
      // 그 시험지를 보고 있으면 진행 표시(우측 패널 진행 바)를 바로 켠다.
      if (get().selectedFileId === fileId) {
        set({
          solve: {
            running: true,
            total: created.job.total,
            doneCount: created.job.done_count,
            currentNo: no,
            partial: true,
            error: null,
            aborted: false,
          },
        });
      }
      await get().loadJobs();
      void watchJob(created.job);
    } catch (error) {
      const message = toUserMessage(error);
      set((state) => ({
        problemSolutions: patchProblemSolution(state.problemSolutions, key, (entry) => ({
          ...entry,
          status: 'error',
          error: message,
        })),
      }));
    }
  },

  async loadVariants(fileId: string) {
    const inFlight = variantLoads.get(fileId);
    if (inFlight) return inFlight;

    const load = (async () => {
      try {
        const { variants } = await api.getVariants(fileId);
        if (variants.length === 0) return;
        set((state) => {
          let next = state.variants;
          for (const variant of variants) {
            const key = variantKey(fileId, variant.no);
            // 지금 생성 중인 항목은 건드리지 않는다. 서버 저장본은 이전 판이라
            // 덮어쓰면 흐르고 있는 새 결과가 옛 글로 되돌아간다.
            if (next[key]?.[variant.mode]?.status === 'streaming') continue;
            next = setVariant(next, key, variant.mode, {
              mode: variant.mode,
              text: variant.text,
              streamingText: '',
              status: 'done',
              usage: variant.usage,
              cost: variant.cost,
              error: null,
            });
          }
          return { variants: next };
        });
      } catch {
        // 저장 변형 조회 실패는 화면을 막지 않는다(생성은 여전히 가능).
      } finally {
        variantLoads.delete(fileId);
      }
    })();
    variantLoads.set(fileId, load);
    return load;
  },

  async generateVariant(fileId: string, no: number, mode: VariantMode, opts = {}) {
    const { force = false } = opts;
    const key = variantKey(fileId, no);
    const guard = `${key}::${mode}`;
    // 같은 (문항, 유형)을 두 번 겹쳐 걸지 않는다. 아래에 await 가 있어
    // 스토어 상태만으로는 재진입을 막을 수 없다(StrictMode 이중 호출 포함).
    if (variantStarting.has(guard)) return;

    // 캐시 규칙: 생성 중이면 no-op, 이미 done 이면 force 일 때만 재생성.
    if (get().variants[key]?.[mode]?.status === 'streaming') return;
    if (get().variants[key]?.[mode]?.status === 'done' && !force) return;

    variantStarting.add(guard);
    try {
      // **생성 전에 저장본을 먼저 확인한다.** 오답노트처럼 시험지를 열지 않고
      // 패널만 뜨는 화면은 캐시가 비어 있어, 이미 만들어 둔 변형이 있어도
      // 생성을 걸게 된다. 서버는 그것을 400 `already_generated` 로 거절하므로
      // 사용자는 에러만 보고 저장본은 영영 못 본다.
      if (!force) {
        await get().loadVariants(fileId);
        const cached = get().variants[key]?.[mode];
        if (cached?.status === 'done' || cached?.status === 'streaming') return;
      }

      const { model, effort, provider } = get();
      set((state) => ({
        variants: setVariant(state.variants, key, mode, {
          mode,
          text: '',
          streamingText: '',
          status: 'streaming',
          usage: null,
          cost: null,
          error: null,
        }),
      }));

      try {
        const created = await api.createJob({
          kind: 'variant',
          node_id: fileId,
          no,
          modes: [mode],
          // 서버도 이미 만든 (문항, 종류)를 건너뛴다. "다시 생성" 은 그 규칙을
          // 넘어야 하므로 force 를 실어야 한다(안 실으면 400 으로 거절된다).
          force,
          provider,
          model,
          effort,
        });
        rememberVariantTargets(created.job.id, [{ no, mode }]);
        await get().loadJobs();
        void watchJob(created.job);
      } catch (error) {
        // 자리를 먼저 비운다(streaming 인 항목은 조회가 덮어쓰지 않는다).
        set((state) => ({
          variants: patchVariant(state.variants, key, mode, (entry) => ({
            ...entry,
            status: 'error',
            error: toUserMessage(error),
          })),
        }));
        // 조회와 생성 사이에 다른 창이 만들어 둔 경우. 서버가 "이미 있다" 고
        // 알려 준 것이므로 그 저장본을 받아 에러 대신 결과를 보여준다.
        if (error instanceof ApiError && error.code === 'already_generated') {
          await get().loadVariants(fileId);
        }
      }
    } finally {
      variantStarting.delete(guard);
    }
  },

  async loadTranscripts(fileId: string) {
    const inFlight = transcriptLoads.get(fileId);
    if (inFlight) return inFlight;

    const load = (async () => {
      try {
        const { transcripts } = await api.getTranscripts(fileId);
        set((state) => {
          const next = { ...state.transcripts };
          const seen = new Set<string>();
          for (const item of transcripts) {
            const key = transcriptCacheKey(fileId, item.no);
            seen.add(key);
            // 판독 중인 자리는 건드리지 않는다. 서버 저장본은 이전 판이라
            // 덮으면 흐르고 있는 새 결과가 옛 글로 되돌아간다.
            if (next[key]?.status === 'running') continue;
            next[key] = {
              ...emptyTranscript(item.no),
              text: item.transcript ?? '',
              status: 'done',
              source: transcriptSourceOf(item.transcript_source),
              note: item.transcript_note,
            };
          }
          // 목록에서 빠진 문항은 판독본이 지워진 것이다(다른 창의 편집·재추출).
          // 남겨 두면 화면이 서버에 없는 판독본을 계속 보여준다.
          for (const [key, entry] of Object.entries(next)) {
            if (!key.startsWith(`${fileId}::`) || seen.has(key)) continue;
            if (entry.status === 'running' || entry.status === 'idle') continue;
            next[key] = emptyTranscript(entry.no);
          }
          return { transcripts: next };
        });
      } catch {
        // 판독본 조회 실패는 화면을 막지 않는다(실행은 여전히 가능).
      } finally {
        transcriptLoads.delete(fileId);
      }
    })();
    transcriptLoads.set(fileId, load);
    return load;
  },

  async startTranscribe(problemNumbers: number[] | null, opts = {}) {
    const { force = false } = opts;
    const { selectedFileId, fileDetail, model, effort, provider } = get();
    if (!selectedFileId) {
      get().showToast({ kind: 'info', message: '먼저 왼쪽에서 시험지 파일을 선택하세요.' });
      return;
    }

    let created;
    try {
      created = await api.createJob({
        kind: 'transcribe',
        node_id: selectedFileId,
        problem_numbers: problemNumbers,
        force,
        provider,
        model,
        effort,
      });
    } catch (error) {
      // "이미 모두 텍스트로 옮겨져 있습니다" 같은 거절도 여기로 온다. 힌트가
      // 빠져나올 방법("다시 판독")을 알려주므로 함께 보여준다. 화면의 판독본은
      // 손대지 않는다 — 거절은 데이터를 잃을 이유가 아니다.
      get().showToast({
        kind: 'info',
        message: toUserMessage(error),
        hint: toUserHint(error),
      });
      return;
    }

    if (created.existing) {
      // 서버가 겹치는 작업을 돌려줬다 = 이번 요청은 큐에 들어가지 않았다.
      // 자리를 만들면 아무도 채우지 않아 유령 진행 표시가 된다(변형과 같은 규칙).
      get().showToast({
        kind: 'info',
        message: '이 시험지의 문항 텍스트화가 이미 진행 중이라 새로 걸지 않았습니다.',
        hint: '진행 중인 작업이 끝난 뒤 다시 눌러 주세요. 진행 상황은 상단 배너에 있습니다.',
      });
      await get().loadJobs();
      void watchJob(created.job);
      return;
    }

    // 진행 자리를 먼저 만든다(진행 표시의 단일 소스). 서버가 이미 판독한 문항을
    // 건너뛰므로, 자리도 실제 대상(=아직 판독본이 없는 문항)에만 만든다.
    const requested =
      problemNumbers ?? (fileDetail?.problems ?? []).map((problem) => problem.no);
    const targets = requested.filter((no) => {
      if (force) return true;
      return (get().transcripts[transcriptCacheKey(selectedFileId, no)]?.text ?? '') === '';
    });
    set((state) => {
      const next = { ...state.transcripts };
      for (const no of targets) {
        const key = transcriptCacheKey(selectedFileId, no);
        next[key] = { ...(next[key] ?? emptyTranscript(no)), status: 'running', error: null };
      }
      return { transcripts: next, activeTab: 'solutions' };
    });
    // 중간에 멈추면 이 자리들을 정리해야 한다(watchJob 의 finally).
    rememberTranscribeTargets(created.job.id, targets);

    get().showToast({
      kind: 'success',
      message: `${created.job.total}개 문항을 텍스트로 옮기기 시작했습니다.`,
      hint: 'PDF 에서 바로 읽는 것이 1차라 대부분은 AI 호출 없이 끝납니다. 화면을 떠나도 계속 진행됩니다.',
    });
    await get().loadJobs();
    void watchJob(created.job);
  },

  async saveTranscript(fileId: string, no: number, text: string) {
    const key = transcriptCacheKey(fileId, no);
    set((state) => ({
      transcripts: {
        ...state.transcripts,
        [key]: { ...(state.transcripts[key] ?? emptyTranscript(no)), saving: true },
      },
    }));
    try {
      const saved = await api.saveTranscript(fileId, no, text);
      set((state) => ({
        transcripts: {
          ...state.transcripts,
          [key]: {
            ...emptyTranscript(no),
            text: saved.transcript ?? '',
            // 지운 뒤에는 미판독으로 되돌린다 — 다음 재실행이 다시 대상으로 잡는다.
            status: saved.transcript == null ? 'idle' : 'done',
            source: transcriptSourceOf(saved.transcript_source),
            note: saved.transcript_note,
          },
        },
      }));
      return true;
    } catch (error) {
      // 실패하면 화면의 값을 바꾸지 않는다(사용자가 고친 초안을 잃지 않게).
      set((state) => ({
        transcripts: state.transcripts[key]
          ? { ...state.transcripts, [key]: { ...state.transcripts[key]!, saving: false } }
          : state.transcripts,
      }));
      get().showToast({
        kind: 'error',
        message: toUserMessage(error),
        hint: toUserHint(error),
      });
      return false;
    }
  },

  async sendChat(message: string) {
    const trimmed = message.trim();
    if (trimmed === '') return;
    const { selectedFileId, model, effort, provider, selectedProblemNo, chatSending, fileDetail } =
      get();
    if (chatSending) return;

    const availableNos = fileDetail?.problems.map((problem) => problem.no) ?? [];

    // ── 1차: 시험지가 열려 있고 오답노트 추가 의도면 AI 를 부르지 않고 직접 처리(계약 6-A) ──
    if (selectedFileId) {
      const intent = parseNoteAddIntent(trimmed, availableNos);
      if (intent.isAddIntent) {
        dataEpoch += 1;
        chatSeq += 1;
        const userEntry: ChatEntry = {
          id: `user-${chatSeq}`,
          role: 'user',
          content: trimmed,
          streaming: false,
          usage: null,
          cost: null,
          error: null,
          createdAt: new Date().toISOString(),
          problemNo: selectedProblemNo,
          fileId: selectedProblemNo != null ? selectedFileId : null,
        };
        set((state) => ({ messages: [...state.messages, userEntry] }));
        await get().handleNoteAddIntent(intent, selectedFileId, availableNos);
        return;
      }
    }

    // 문항 첨부: 시험지가 열려 있을 때만. 직접 클릭한 문항이 우선이고, 없으면 문장에서 찾는다.
    const attachedProblemNo = selectedFileId
      ? (selectedProblemNo ?? detectProblemNo(trimmed, availableNos))
      : null;
    // file_id 와 problem_no 는 짝으로 싣는다("N번 풀이로 저장" 이 둘을 모두 요구).
    const attachedFileId = attachedProblemNo != null ? selectedFileId : null;

    // 전송을 시작한 즉시 상태를 잡는다. (대화 생성이 비동기라, 이 플래그를 나중에
    // 세우면 "전송 중이 아님" 창이 생겨 UI 가 이미 끝난 것으로 오인한다.)
    set({ chatSending: true, chatStatus: 'ready' });

    // 활성 대화가 없으면 새로 만든다(ChatGPT식: 첫 전송 시 생성).
    let conversationId = get().activeConversationId;
    if (!conversationId) {
      try {
        const conversation = await api.createConversation();
        conversationId = conversation.id;
        set((state) => ({
          activeConversationId: conversation.id,
          conversations: [conversation, ...state.conversations],
        }));
        persistPrefs({ lastConversationId: conversation.id });
      } catch (error) {
        set({ chatSending: false });
        get().showToast({ kind: 'error', message: toUserMessage(error) });
        return;
      }
    }

    // 뒤늦게 도착할 이력 응답이 방금 보낸 메시지를 덮어쓰지 못하게 한다.
    dataEpoch += 1;
    chatSeq += 1;
    const userId = `user-${chatSeq}`;
    chatSeq += 1;
    const assistantId = `assistant-${chatSeq}`;

    set((state) => ({
      chatSending: true,
      chatStatus: 'ready',
      messages: [
        ...state.messages,
        {
          id: userId,
          role: 'user',
          content: trimmed,
          streaming: false,
          usage: null,
          cost: null,
          error: null,
          createdAt: new Date().toISOString(),
          problemNo: attachedProblemNo,
          fileId: attachedFileId,
        },
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          streaming: true,
          usage: null,
          cost: null,
          error: null,
          createdAt: new Date().toISOString(),
          problemNo: attachedProblemNo,
          fileId: attachedFileId,
        },
      ],
    }));

    chatController = new AbortController();
    try {
      const stream = api.conversationChat(
        conversationId,
        {
          message: trimmed,
          file_id: attachedFileId,
          problem_no: attachedProblemNo,
          provider,
          model,
          effort,
        },
        chatController.signal,
      );
      for await (const event of stream) {
        if (get().activeConversationId !== conversationId) break;
        switch (event.type) {
          case 'delta':
            set((state) => ({
              messages: state.messages.map((entry) =>
                entry.id === assistantId
                  ? { ...entry, content: entry.content + event.text }
                  : entry,
              ),
            }));
            break;
          case 'done':
            set((state) => ({
              messages: state.messages.map((entry) =>
                entry.id === assistantId
                  ? {
                      ...entry,
                      content: event.solution || entry.content,
                      streaming: false,
                      usage: event.usage,
                      cost: event.cost,
                    }
                  : entry,
              ),
              totals: accumulate(state.totals, event.usage, event.cost),
              // 이력이 잘려 보내졌으면 사용자에게 알린다.
              chatTruncatedBefore: event.history_truncated ? (event.truncated_before ?? 0) : 0,
            }));
            break;
          case 'error':
            set((state) => ({
              messages: state.messages.map((entry) =>
                entry.id === assistantId
                  ? { ...entry, streaming: false, error: event.message }
                  : entry,
              ),
            }));
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        const messageText = toUserMessage(error);
        set((state) => ({
          messages: state.messages.map((entry) =>
            entry.id === assistantId ? { ...entry, streaming: false, error: messageText } : entry,
          ),
        }));
      }
    } finally {
      chatController = null;
      set((state) => ({
        chatSending: false,
        messages: state.messages.map((entry) =>
          entry.id === assistantId && entry.streaming ? { ...entry, streaming: false } : entry,
        ),
      }));
      // 대화 목록(제목/미리보기/시간) 갱신.
      void get().loadConversations();
      // 채팅이 끝났으니 쿼터 사용량 요약도 갱신한다(실패는 조용히 무시).
      void get().loadUsageSummary();
    }
  },

  async handleNoteAddIntent(
    intent: { problemNos: number[]; noteQuery: string | null },
    sourceNodeId: string,
    availableNos: readonly number[],
  ) {
    const problems = intent.problemNos.length > 0 ? intent.problemNos : [];
    if (problems.length === 0) {
      pushSystemMessage(
        set,
        `문항 번호를 알아내지 못했습니다. 예: "5번 6번 이현우 오답노트에 추가해줘" (이 시험지: ${availableNos[0] ?? 1}~${availableNos[availableNos.length - 1] ?? 22}번)`,
      );
      return;
    }

    // 노트 목록을 항상 최신으로 가져와 이름을 매칭한다(임의 생성 금지).
    let allNoteNodes: TreeNode[] = [];
    try {
      const { nodes } = await api.getTree('note');
      allNoteNodes = nodes;
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
      return;
    }
    const noteNodes = allNoteNodes.filter((node) => node.type === 'file');

    if (intent.noteQuery == null) {
      if (noteNodes.length === 0) {
        pushSystemMessage(
          set,
          '오답노트가 아직 없습니다. 왼쪽 [오답노트] 섹션에서 노트를 먼저 만들어 주세요. 예: "5번 이현우 오답노트에 추가해줘" 처럼 학생 이름을 함께 말해도 됩니다.',
        );
        return;
      }
      pushSystemMessage(
        set,
        `어느 오답노트에 담을지 말씀해 주세요. 예: "${problems.join(', ')}번 ${noteNodes[0]?.name ?? '이현우'} 오답노트에 추가"`,
      );
      return;
    }

    // 이름 부분일치로 노트를 찾는다. 학생 이름은 보통 상위 폴더이므로
    // 노트 파일명뿐 아니라 조상 폴더 이름까지 포함한 문자열로 매칭한다.
    const query = intent.noteQuery;
    const byId = new Map(allNoteNodes.map((node) => [node.id, node]));
    const haystackFor = (note: TreeNode): string => {
      const parts: string[] = [note.name];
      let current = note.parent_id ? byId.get(note.parent_id) : undefined;
      let guard = 0;
      while (current && guard < 50) {
        parts.push(current.name);
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
        guard += 1;
      }
      return parts.join(' ');
    };
    const matches = noteNodes.filter((node) => {
      const haystack = haystackFor(node);
      return haystack.includes(query) || query.includes(node.name);
    });

    if (matches.length === 1) {
      const note = matches[0];
      if (note) {
        await get().addProblemsToNote(note.id, sourceNodeId, problems);
        pushSystemMessage(
          set,
          `${problems.join(', ')}번을 "${note.name}" 오답노트에 담았습니다.`,
        );
      }
      return;
    }

    if (matches.length > 1) {
      pushSystemMessage(
        set,
        `"${query}" 와 비슷한 오답노트가 여러 개입니다(${matches.map((n) => n.name).join(', ')}). 왼쪽 [오답노트] 섹션에서 담을 노트를 골라 주세요.`,
      );
      return;
    }

    // 없으면 임의 생성하지 않고 물어본다(계약 6-A).
    set({
      notePrompt: {
        kind: 'create-note',
        noteName: query,
        sourceNodeId,
        problemNumbers: problems,
      },
    });
  },

  abortChat() {
    if (!chatController) return;
    chatController.abort();
    chatController = null;
    set((state) => ({
      chatSending: false,
      messages: state.messages.map((entry) =>
        entry.streaming
          ? { ...entry, streaming: false, error: entry.content === '' ? '중단했습니다.' : null }
          : entry,
      ),
    }));
  },

  setModel(model: string) {
    set({ model });
    persistPrefs({ model });
  },

  setEffort(effort: Effort) {
    set({ effort });
    persistPrefs({ effort });
  },

  setProvider(provider: ProviderChoice) {
    // provider 를 바꾸면 모델도 그 provider 의 것으로 맞춘다(계약 3-C: 모델은 provider 종속).
    const config = get().providerConfig;
    let model = get().model;
    if (config) {
      const models = config.options.find((option) => option.id === provider)?.models ?? [];
      if (!models.some((candidate) => candidate.id === model)) {
        model = defaultModelForProvider(config, provider) ?? model;
      }
    }
    set({ provider, model });
    persistPrefs({ model, provider });
  },

  setRightWidth(width: number) {
    const clamped = clampWidth(width);
    set({ rightWidth: clamped });
    persistPrefs({ rightWidth: clamped });
  },

  setLeftWidth(width: number) {
    const clamped = clampLeftWidth(width);
    set({ leftWidth: clamped });
    persistPrefs({ leftWidth: clamped });
  },

  toggleLeftCollapsed() {
    const next = !get().leftCollapsed;
    set({ leftCollapsed: next });
    persistPrefs({ leftCollapsed: next });
  },

  toggleRightCollapsed() {
    const next = !get().rightCollapsed;
    set({ rightCollapsed: next });
    persistPrefs({ rightCollapsed: next });
  },

  showToast(toast: ToastMessage) {
    set({ toast });
  },

  dismissToast() {
    set({ toast: null });
  },
}));

/**
 * 저수준 클라이언트(http/mock)가 401 을 만나면 여기로 통지된다.
 * 저장 비번은 access-gate 가 이미 지웠고, 여기서는 화면을 로그인으로 되돌린다.
 */
setUnauthorizedHandler(() => {
  useWorkspace.getState().handleUnauthorized();
});

/* ── 순수 헬퍼 ────────────────────────────────────────────────── */

function patchEntry(
  solutions: Record<number, SolutionEntry>,
  no: number,
  update: (entry: SolutionEntry) => SolutionEntry,
): Record<number, SolutionEntry> {
  const current = solutions[no] ?? emptyEntry(no);
  return { ...solutions, [no]: update(current) };
}

/** 한 문항(key)의 특정 mode 항목을 통째로 설정한다. */
function setVariant(
  variants: Record<string, VariantByMode>,
  key: string,
  mode: VariantMode,
  entry: VariantEntry,
): Record<string, VariantByMode> {
  return { ...variants, [key]: { ...variants[key], [mode]: entry } };
}

function patchVariant(
  variants: Record<string, VariantByMode>,
  key: string,
  mode: VariantMode,
  update: (entry: VariantEntry) => VariantEntry,
): Record<string, VariantByMode> {
  const current = variants[key]?.[mode];
  if (!current) return variants;
  return { ...variants, [key]: { ...variants[key], [mode]: update(current) } };
}

/** `problemSolutions[key]` 항목을 갱신한다(없으면 그대로 둔다). */
function patchProblemSolution(
  map: Record<string, SolutionEntry>,
  key: string,
  update: (entry: SolutionEntry) => SolutionEntry,
): Record<string, SolutionEntry> {
  const current = map[key];
  if (!current) return map;
  return { ...map, [key]: update(current) };
}

/** 스트림이 done 없이 끝났을 때 그 mode 의 streaming 상태를 정리한다. */
function settleVariant(
  variants: Record<string, VariantByMode>,
  key: string,
  mode: VariantMode,
): Record<string, VariantByMode> {
  const current = variants[key]?.[mode];
  if (!current || current.status !== 'streaming') return variants;
  const next: VariantEntry = current.streamingText
    ? { ...current, status: 'done', text: current.streamingText, streamingText: '' }
    : { ...current, status: 'error', error: current.error ?? '중단했습니다.' };
  return { ...variants, [key]: { ...variants[key], [mode]: next } };
}

/** 그 시험지의 판독본 캐시를 통째로 버린다(재추출로 서버에서 지워졌을 때). */
function dropFileTranscripts(
  transcripts: Record<string, TranscriptEntry>,
  fileId: string,
): Record<string, TranscriptEntry> {
  const prefix = `${fileId}::`;
  const next: Record<string, TranscriptEntry> = {};
  let changed = false;
  for (const [key, entry] of Object.entries(transcripts)) {
    if (key.startsWith(prefix)) {
      changed = true;
      continue;
    }
    next[key] = entry;
  }
  return changed ? next : transcripts;
}

/**
 * 스트림이 done 없이 끝났을 때 그 문항의 'running' 을 정리한다.
 *
 * 판독은 델타 없이 끝나는 경로(1차 디코딩)가 있어 부분 텍스트를 결과로 승격할 수
 * 없다. 이미 확보한 전문이 있으면 그것으로 되돌리고, 없으면 미판독으로 되돌린다
 * (다음 실행이 다시 대상으로 잡는다).
 */
function settleTranscript(
  transcripts: Record<string, TranscriptEntry>,
  key: string,
): Record<string, TranscriptEntry> {
  const current = transcripts[key];
  if (!current || current.status !== 'running') return transcripts;
  return {
    ...transcripts,
    [key]: {
      ...current,
      status: current.text === '' ? 'idle' : 'done',
      streamingText: '',
      route: null,
    },
  };
}

function resetTargets(
  solutions: Record<number, SolutionEntry>,
  targets: number[] | null,
): Record<number, SolutionEntry> {
  if (!targets) return solutions;
  const next = { ...solutions };
  for (const no of targets) {
    const current = next[no] ?? emptyEntry(no);
    next[no] = { ...current, status: 'empty', streamingText: '', error: null };
  }
  return next;
}

/** 스트림이 끊겼을 때 'running' 으로 남은 항목을 정리한다. */
function settleRunning(
  solutions: Record<number, SolutionEntry>,
): Record<number, SolutionEntry> {
  let changed = false;
  const next: Record<number, SolutionEntry> = { ...solutions };
  for (const key of Object.keys(next)) {
    const no = Number(key);
    const entry = next[no];
    if (!entry || entry.status !== 'running') continue;
    changed = true;
    next[no] = entry.streamingText
      ? { ...entry, status: 'done', text: entry.streamingText, streamingText: '' }
      : { ...entry, status: 'empty' };
  }
  return changed ? next : solutions;
}

function accumulate(totals: SessionTotals, usage: Usage | null, cost: Cost | null): SessionTotals {
  // 과금 여부의 판별 기준은 `cost` 하나다.
  //   구독 모드 : usage 는 실제 값이 오고 cost 만 null  -> 토큰은 세되 금액은 세지 않는다
  //   API 키 모드: usage + cost 둘 다 온다              -> 토큰과 금액을 모두 센다
  // `!usage && !cost` 로 판별하면 구독 호출이 "$0 과금 호출" 로 잘못 집계된다.
  if (cost == null) {
    return {
      ...totals,
      usage: mergeUsage(totals.usage, usage),
      subscriptionCalls: totals.subscriptionCalls + 1,
    };
  }
  return {
    usage: mergeUsage(totals.usage, usage),
    usd: totals.usd + (cost.total_usd ?? 0),
    krw: totals.krw + (cost.total_krw ?? 0),
    billedCalls: totals.billedCalls + 1,
    subscriptionCalls: totals.subscriptionCalls,
  };
}

/* 테스트에서 쓰는 내부 헬퍼 노출 */
/**
 * 테스트 전용: 작업 구독 맵을 비운다.
 *
 * 구독 맵은 모듈 전역이라 스토어를 리셋해도 남는다. 목 작업 id 는 테스트마다
 * `job-1` 로 재사용되므로, 비우지 않으면 다음 테스트의 새 작업이 "이미 구독 중"
 * 으로 판정되어 이벤트를 받지 못한다.
 */
function resetJobSubscriptions(): void {
  for (const controller of jobSubscriptions.values()) controller.abort();
  jobSubscriptions.clear();
  // 구독에 딸린 모듈 상태도 함께 버린다(테스트가 스토어를 통째로 되돌릴 때
  // 이것들만 남으면 다음 케이스가 "이미 요청 중" 으로 오인한다).
  variantJobTargets.clear();
  variantStarting.clear();
  variantLoads.clear();
  transcribeJobTargets.clear();
  transcriptLoads.clear();
}

export const __internal = {
  resetJobSubscriptions,
  patchEntry,
  resetTargets,
  settleRunning,
  accumulate,
  emptyEntry,
  setVariant,
  patchVariant,
  settleVariant,
  variantKey,
  emptyTranscript,
  settleTranscript,
};
