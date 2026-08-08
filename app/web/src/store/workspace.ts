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
import { isAbortError, toUserMessage } from '@/lib/api-error';
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
import { uploadTargetLabel } from '@/lib/upload-target';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type Conversation,
  type ConversationMessage,
  type Cost,
  type Effort,
  type EnvResponse,
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
  /** 마지막으로 열어 본 시험지 파일 id(새로고침 복원용). null = 없음. */
  lastFileId?: string | null;
  /** 마지막으로 보던 전역 대화 id(새로고침 복원용). null = 없음(새 대화 초안). */
  lastConversationId?: string | null;
}

export const RIGHT_MIN = 320;
export const RIGHT_MAX = 720;
export const RIGHT_DEFAULT = 400;

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
  createFolder: (name: string, parentId: string | null) => Promise<boolean>;
  createNote: (name: string, parentId: string | null) => Promise<boolean>;
  renameNode: (id: string, name: string) => Promise<boolean>;
  moveNode: (id: string, parentId: string | null) => Promise<boolean>;
  deleteNode: (id: string) => Promise<boolean>;
  uploadFiles: (files: File[], parentId: string | null) => Promise<void>;

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
  confirmNotePrompt: () => Promise<void>;
  cancelNotePrompt: () => void;

  startSolve: (problemNumbers: number[] | null) => Promise<void>;
  abortSolve: () => void;

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

  showToast: (toast: ToastMessage) => void;
  dismissToast: () => void;
}

/* 스트림 중단 컨트롤러는 상태가 아니라 모듈 변수로 둔다(직렬화 대상 아님). */
let solveController: AbortController | null = null;
let chatController: AbortController | null = null;
let chatSeq = 0;

/** 변형 생성 스트림 컨트롤러(`${key}::${mode}` → controller). 직렬화 대상 아님. */
const variantControllers = new Map<string, AbortController>();

/** 변형 결과 저장 키: 시험지 문항(file_id + problem_no) 단위. */
function variantKey(fileId: string, no: number): string {
  return `${fileId}::${no}`;
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
      set((state) => {
        // 이 섹션의 루트 폴더는 펼쳐서 보여준다.
        const expanded = { ...state.expanded };
        for (const node of nodes) {
          if (node.type === 'folder' && node.parent_id === null && expanded[node.id] === undefined) {
            expanded[node.id] = true;
          }
        }
        return { nodes, treeStatus: 'ready', expanded };
      });
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
      });
    } catch (error) {
      get().showToast({ kind: 'error', message: toUserMessage(error) });
    } finally {
      set({ pendingOp: null });
    }
    if (lastId) await get().selectFile(lastId);
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
    // 진행 중인 풀이 스트림은 파일이 바뀌면 의미가 없다.
    // (대화는 파일과 무관한 전역 세션이므로 파일을 바꿔도 유지한다.)
    get().abortSolve();
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
  },

  async selectNote(id: string) {
    if (get().openKind === 'note' && get().selectedNoteId === id) return;
    get().abortSolve();

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

  async startSolve(problemNumbers: number[] | null) {
    const { selectedFileId, model, effort, provider, solve } = get();
    if (!selectedFileId) {
      get().showToast({ kind: 'error', message: '먼저 왼쪽에서 파일을 선택하세요.' });
      return;
    }
    if (solve.running) {
      get().showToast({ kind: 'info', message: '이미 풀이가 진행 중입니다.' });
      return;
    }

    const detail = get().fileDetail;
    const targets =
      problemNumbers ?? (detail ? detail.problems.map((problem) => problem.no) : null);

    // 뒤늦게 도착할 기존 풀이 응답이 스트리밍 결과를 덮어쓰지 못하게 한다.
    dataEpoch += 1;
    solveController = new AbortController();
    set((state) => ({
      activeTab: 'solutions',
      solve: {
        running: true,
        total: targets?.length ?? 0,
        doneCount: 0,
        currentNo: null,
        partial: problemNumbers != null,
        error: null,
        aborted: false,
      },
      // 대상 문제는 대기 상태로 초기화한다.
      solutions: resetTargets(state.solutions, targets),
    }));

    try {
      const stream = api.solve(
        selectedFileId,
        { problem_numbers: problemNumbers, provider, model, effort },
        solveController.signal,
      );

      for await (const event of stream) {
        if (get().selectedFileId !== selectedFileId) break;
        switch (event.type) {
          case 'start':
            set((state) => ({ solve: { ...state.solve, total: event.total } }));
            break;
          case 'problem':
            set((state) => ({
              solve: { ...state.solve, currentNo: event.no },
              solutions: patchEntry(state.solutions, event.no, (entry) => ({
                ...entry,
                status: 'running',
                streamingText: '',
                error: null,
              })),
            }));
            break;
          case 'delta':
            if (event.no != null) {
              set((state) => ({
                solutions: patchEntry(state.solutions, event.no as number, (entry) => ({
                  ...entry,
                  status: 'running',
                  streamingText: entry.streamingText + event.text,
                })),
              }));
            }
            break;
          case 'done':
            if (event.no != null) {
              set((state) => ({
                solve: { ...state.solve, doneCount: state.solve.doneCount + 1 },
                solutions: patchEntry(state.solutions, event.no as number, (entry) => ({
                  ...entry,
                  status: 'done',
                  text: event.solution || entry.streamingText,
                  streamingText: '',
                  usage: event.usage,
                  cost: event.cost,
                  truncated: event.truncated,
                  error: null,
                  createdAt: new Date().toISOString(),
                })),
                totals: accumulate(state.totals, event.usage, event.cost),
              }));
            }
            break;
          case 'error':
            if (event.no != null) {
              set((state) => ({
                solve: { ...state.solve, doneCount: state.solve.doneCount + 1 },
                solutions: patchEntry(state.solutions, event.no as number, (entry) => ({
                  ...entry,
                  status: 'error',
                  error: event.message,
                })),
              }));
            } else {
              set((state) => ({ solve: { ...state.solve, error: event.message } }));
            }
            break;
          case 'end':
            set((state) => ({ solve: { ...state.solve, running: false, currentNo: null } }));
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        const message = toUserMessage(error);
        set((state) => ({ solve: { ...state.solve, error: message } }));
        get().showToast({ kind: 'error', message });
      }
    } finally {
      solveController = null;
      set((state) => ({
        solve: { ...state.solve, running: false, currentNo: null },
        solutions: settleRunning(state.solutions),
      }));
      // 풀이가 끝났으니 쿼터 사용량 요약을 갱신한다(실패는 조용히 무시).
      void get().loadUsageSummary();
    }
  },

  abortSolve() {
    if (!solveController) return;
    solveController.abort();
    solveController = null;
    set((state) => ({
      solve: { ...state.solve, running: false, aborted: true, currentNo: null },
      solutions: settleRunning(state.solutions),
    }));
  },

  async generateVariant(fileId: string, no: number, mode: VariantMode, opts = {}) {
    const { force = false } = opts;
    const key = variantKey(fileId, no);
    const existing = get().variants[key]?.[mode];

    // 캐시 규칙: 스트리밍 중이면 언제나 no-op(중복 실행 방지),
    // 이미 done 이면 force 일 때만 재생성. idle/error 는 최초 생성으로 진행한다.
    if (existing?.status === 'streaming') return;
    if (existing?.status === 'done' && !force) return;

    const { model, effort, provider } = get();
    const controllerKey = `${key}::${mode}`;
    const controller = new AbortController();
    variantControllers.set(controllerKey, controller);

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
      const stream = api.generateVariant(
        fileId,
        no,
        mode,
        { provider, model, effort },
        controller.signal,
      );
      for await (const event of stream) {
        switch (event.type) {
          case 'delta':
            set((state) => ({
              variants: patchVariant(state.variants, key, mode, (entry) => ({
                ...entry,
                status: 'streaming',
                streamingText: entry.streamingText + event.text,
              })),
            }));
            break;
          case 'done':
            set((state) => ({
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
          case 'error':
            set((state) => ({
              variants: patchVariant(state.variants, key, mode, (entry) => ({
                ...entry,
                status: 'error',
                error: event.message,
              })),
            }));
            break;
          default:
            break;
        }
      }
    } catch (error) {
      if (!isAbortError(error)) {
        const message = toUserMessage(error);
        set((state) => ({
          variants: patchVariant(state.variants, key, mode, (entry) => ({
            ...entry,
            status: 'error',
            error: message,
          })),
        }));
      }
    } finally {
      if (variantControllers.get(controllerKey) === controller) {
        variantControllers.delete(controllerKey);
      }
      // 스트림이 done 없이 끊겼으면(중단/네트워크) streaming 을 정리한다.
      set((state) => ({ variants: settleVariant(state.variants, key, mode) }));
      // 변형 생성도 쿼터를 소비하므로 사용량 요약을 갱신한다(실패는 조용히 무시).
      void get().loadUsageSummary();
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
export const __internal = {
  patchEntry,
  resetTargets,
  settleRunning,
  accumulate,
  emptyEntry,
  setVariant,
  patchVariant,
  settleVariant,
  variantKey,
};
