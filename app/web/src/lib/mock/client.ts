/**
 * 목 API 클라이언트. `NEXT_PUBLIC_MOCK=1` 일 때 실제 fetch 대신 이걸 쓴다.
 *
 * - 메모리 상태를 들고 있어 폴더 생성/이름변경/이동/삭제가 실제로 반영된다.
 * - 스트리밍은 진짜 SSE 바이트를 만들어 실제 파서를 통과시킨다(`mock/sse-stream.ts`).
 * - 백엔드가 붙은 뒤에도 개발/회귀 확인용으로 남겨둔다.
 */

import { ApiError } from '@/lib/api-error';
import { readStoredPassword, reportUnauthorized } from '@/lib/access-gate';
import { iterateSSE } from '@/lib/sse';
import { toStreamEvent } from '@/lib/stream-events';
import { mockSseStream, type MockSseEvent } from '@/lib/mock/sse-stream';
import {
  MOCK_ACCESS_PASSWORD,
  MOCK_ANCHOR_EXTRACT_ERROR,
  MOCK_NOTE_ID,
  MOCK_PDF_PATH,
  MOCK_PROBLEM_COUNT,
  MOCK_SCAN_EXTRACT_ERROR,
  MOCK_TRANSCRIPT_NOTE,
  makeMockEnv,
  makeMockNodes,
  makeMockNoteNodes,
  makeMockProblems,
  mockAiReadable,
  mockChatReply,
  mockCropUrl,
  mockDecodable,
  mockProblemText,
  mockSolutionText,
  mockTranscriptText,
  mockVariantText,
} from '@/lib/mock/data';
import type { ApiClient } from '@/lib/api-client';
import type {
  AddNoteItemsResult,
  ChatHistoryResponse,
  ChatMessage,
  ChatRequest,
  Conversation,
  ConversationChatRequest,
  ConversationMessage,
  ConversationMessagesResponse,
  ConversationsResponse,
  Cost,
  EnvResponse,
  FileDetail,
  NoteDetail,
  NoteItem,
  Problem,
  ProviderChoice,
  Job,
  JobCreateRequest,
  JobCreated,
  ExportFormat,
  ExportInclude,
  ExportTarget,
  JobsResponse,
  VariantsResponse,
  ReextractResult,
  Section,
  Solution,
  SolutionsResponse,
  StreamEvent,
  ThreadsResponse,
  Transcript,
  TranscriptsResponse,
  TreeNode,
  TreeResponse,
  Usage,
  UsageSummaryResponse,
  Variant,
  VariantMode,
  ExportBody,
} from '@/types/api';

/** DOCX(Word) MIME. '문제만' 내보내기 목 blob 에 쓴다. */
const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** HWPX(한글) MIME. */
const HWPX_MEDIA_TYPE = 'application/hwp+zip';

/** 판독본 길이 상한(백엔드 `config.MAX_TRANSCRIPT_LENGTH` 와 같은 값). */
const MOCK_TRANSCRIPT_MAX_LENGTH = 20_000;

/** 문항별 스레드 키. null = 시험지 전역. */
function threadKey(fileId: string, problemNo: number | null): string {
  return `${fileId}::${problemNo ?? 'global'}`;
}

/** 전역 대화 1건의 내부 표현(메시지 포함). */
interface MockConversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  /** 제목이 자동 지정 가능한 상태인지(첫 메시지에만 자동 제목을 붙인다). */
  autoTitle: boolean;
  messages: ConversationMessage[];
}

interface MockState {
  env: EnvResponse;
  nodes: TreeNode[];
  problems: Map<string, Problem[]>;
  solutions: Map<string, Map<number, Solution>>;
  /** nodeId -> `${no}::${mode}` -> 변형. 실서버처럼 완료된 변형을 남긴다. */
  variants: Map<string, Map<string, Variant>>;
  /** nodeId -> no -> 판독본. 실서버처럼 문항마다 저장하고 재실행이 건너뛴다. */
  transcripts: Map<string, Map<number, Transcript>>;
  /** key = threadKey(fileId, problemNo). */
  chats: Map<string, ChatMessage[]>;
  /** 전역(파일 무관) 자유 대화. 삽입 순서 배열, 조회 시 updated_at 내림차순 정렬. */
  conversations: MockConversation[];
  /** noteId -> items. */
  noteItems: Map<string, NoteItem[]>;
  /** 작업 큐. 실제 서버처럼 구독과 무관하게 진행한다. */
  jobs: Map<string, MockJob>;
  counter: number;
}

/** 변형 조회 정렬 순서(백엔드 `list_variants` 와 같은 탭 순서). */
const VARIANT_ORDER: Record<VariantMode, number> = {
  number: 0,
  condition: 1,
  number_condition: 2,
};

/** 저장된 변형의 키. */
function variantSlot(no: number, mode: VariantMode): string {
  return `${no}::${mode}`;
}

/** 그 문항의 저장된 판독본(없으면 undefined). */
function savedTranscript(nodeId: string, no: number): Transcript | undefined {
  return state.transcripts.get(nodeId)?.get(no);
}

/**
 * 판독본 3열을 한 번에 쓴다(실서버 `storage.set_transcript` 와 같은 모양).
 *
 * 배지 메타(`has_transcript` 등)는 문항 목록에도 실려 나가므로 함께 갱신한다.
 * 전문도 이유도 없으면 항목을 지운다 — `GET /transcripts` 가 빈 항목을 빼는 것과
 * 같은 상태가 된다.
 */
function writeMockTranscript(nodeId: string, next: Transcript): void {
  const byNo = state.transcripts.get(nodeId) ?? new Map<number, Transcript>();
  if (next.transcript == null && next.transcript_note == null) byNo.delete(next.no);
  else byNo.set(next.no, next);
  state.transcripts.set(nodeId, byNo);

  const problem = (state.problems.get(nodeId) ?? []).find(
    (candidate) => candidate.no === next.no,
  );
  if (problem) {
    problem.has_transcript = next.transcript != null;
    problem.transcript_source = next.transcript_source;
    problem.transcript_note = next.transcript_note;
  }
}

/** 목 작업. `script` 는 미리 만들어 둔 대본이고 워커가 하나씩 소비한다. */
interface MockJob {
  record: Job;
  /** 중복 판정을 위해 무엇을 대상으로 하는지 기억한다(변형도 문항 목록이다). */
  targets: { numbers?: number[]; modes?: VariantMode[] };
  /** 이미 있는 결과도 덮어쓰는 실행인지(판독은 `manual` 보호가 여기에 걸린다). */
  force: boolean;
  script: MockSseEvent[];
  cursor: number;
  partialText: string;
  canceled: boolean;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<(event: MockSseEvent | null) => void>;
}

function initialState(): MockState {
  const nodes = [...makeMockNodes(), ...makeMockNoteNodes()];
  const problems = new Map<string, Problem[]>();
  for (const node of nodes) {
    if (node.type === 'file' && node.section !== 'note' && node.file) {
      problems.set(node.id, makeMockProblems(node.file.problem_count));
    }
  }
  return {
    env: makeMockEnv(),
    nodes,
    problems,
    solutions: new Map(),
    variants: new Map(),
    transcripts: new Map(),
    chats: new Map(),
    conversations: [],
    noteItems: new Map([[MOCK_NOTE_ID, []]]),
    jobs: new Map(),
    counter: 0,
  };
}

/** 대화 preview: 마지막 메시지 앞부분(없으면 null). */
function conversationPreview(conversation: MockConversation): string | null {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last) return null;
  return last.content.slice(0, 80);
}

function toConversationOut(conversation: MockConversation): Conversation {
  return {
    id: conversation.id,
    title: conversation.title,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    preview: conversationPreview(conversation),
  };
}

function findConversation(id: string): MockConversation {
  const conversation = state.conversations.find((candidate) => candidate.id === id);
  if (!conversation) throw new ApiError('not_found', '대화를 찾을 수 없습니다.', null, 404);
  return conversation;
}

let state = initialState();

/** 테스트에서 상태를 초기화한다.
 *
 * 진행 중인 작업 워커(setInterval)를 반드시 먼저 멈춘다. 워커 클로저는 모듈
 * 변수 `state` 를 참조하므로, 살려 두면 **다음 테스트의 상태에** 풀이를 써 넣어
 * 원인을 알기 어려운 간섭을 만든다.
 */
export function resetMockState(): void {
  for (const job of state.jobs.values()) {
    job.canceled = true;
    if (job.timer != null) {
      clearInterval(job.timer);
      job.timer = null;
    }
    job.listeners.clear();
  }
  state = initialState();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 네트워크 지연 흉내 — 로딩 상태가 실제로 보이게 한다. */
const LATENCY_MS = 160;

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * 이 파일의 추출 사유. 실서버는 백엔드가 PDF 를 들여다보고 판정하지만, 목은 원본이
 * 없으므로 노드에 이미 있는 `mode` 로 갈라낸다(스캔본은 `image`). 판정은 여기(가짜
 * 서버)에만 있고 화면은 문장을 그대로 받는다 — 실서버와 같은 역할 분담이다.
 */
function mockExtractError(node: TreeNode, problemCount: number): string | null {
  if (problemCount > 0) return null;
  return node.file?.mode === 'image' ? MOCK_SCAN_EXTRACT_ERROR : MOCK_ANCHOR_EXTRACT_ERROR;
}

function nextId(prefix: string): string {
  state.counter += 1;
  return `${prefix}-${state.counter}`;
}

/** 이 목 환경이 접속 비밀번호를 요구하는지(env.auth_required). */
function authRequired(): boolean {
  return state.env.auth_required === true;
}

/**
 * 백엔드 미들웨어를 흉내낸다: 보호 대상 요청에서 저장된 비번(`X-Access-Password`
 * 흉내)이 없거나 틀리면 401 로 막는다. health/env/login 은 이 검사를 타지 않는다.
 */
function requireAuth(): void {
  if (!authRequired()) return;
  if (readStoredPassword() === MOCK_ACCESS_PASSWORD) return;
  reportUnauthorized();
  throw new ApiError('unauthorized', '접속 비밀번호가 필요합니다.', null, 401);
}

function findNode(id: string): TreeNode {
  const node = state.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new ApiError('not_found', '항목을 찾을 수 없습니다.', null, 404);
  return node;
}

function collectDescendantIds(id: string): string[] {
  const result: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current == null) break;
    for (const node of state.nodes) {
      if (node.parent_id === current) {
        result.push(node.id);
        queue.push(node.id);
      }
    }
  }
  return result;
}

function usageFor(no: number): Usage {
  return {
    input_tokens: 1800 + no * 7,
    output_tokens: 620 + no * 11,
    cache_creation_input_tokens: no === 1 ? 1500 : 0,
    cache_read_input_tokens: no === 1 ? 0 : 1500,
  };
}

function costFor(model: string, usage: Usage): Cost {
  // pricing.py 와 같은 방식(단가 x 토큰)으로 계산한다. 목이므로 opus 단가 기준.
  const rates: Record<string, { input: number; output: number }> = {
    'claude-opus-5': { input: 5, output: 25 },
    'claude-sonnet-5': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
  };
  const rate = rates[model] ?? rates['claude-opus-5'] ?? { input: 5, output: 25 };
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const usd =
    (input / 1e6) * rate.input +
    (output / 1e6) * rate.output +
    (cacheWrite / 1e6) * rate.input * 1.25 +
    (cacheRead / 1e6) * rate.input * 0.1;
  return {
    model,
    resolved_model: model,
    tokens: {
      input,
      output,
      cache_write: cacheWrite,
      cache_read: cacheRead,
      total: input + output + cacheWrite + cacheRead,
    },
    total_usd: Number(usd.toFixed(8)),
    total_krw: Number((usd * state.env.usd_krw).toFixed(4)),
    usd_krw: state.env.usd_krw,
  };
}

/** 구독 모드로 동작하는 요청인지. 구독이면 usage/cost 를 null 로 준다(계약 3-1). */
function isSubscriptionCall(provider: string): boolean {
  if (provider === 'subscription') return true;
  if (provider === 'auto') return state.env.subscription.available;
  return false;
}

/** 텍스트를 자연스러운 크기로 잘라 delta 로 흘린다. */
function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

async function* solveScript(
  fileId: string,
  body: {
    problem_numbers?: number[] | null;
    provider?: ProviderChoice;
    model?: string;
    effort?: string;
  },
): AsyncGenerator<MockSseEvent, void, void> {
  const problems = state.problems.get(fileId) ?? [];
  const targets =
    body.problem_numbers == null || body.problem_numbers.length === 0
      ? problems.map((problem) => problem.no)
      : body.problem_numbers;

  const model = body.model ?? 'claude-opus-5';
  const subscription = isSubscriptionCall(body.provider ?? 'subscription');

  yield { event: 'start', data: { total: targets.length }, delayMs: 120 };

  let totalUsage: Usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  let totalUsd = 0;

  for (const no of targets) {
    yield { event: 'problem', data: { no, status: 'running' }, delayMs: 40 };

    const text = mockSolutionText(no);
    for (const piece of chunkText(text, 24)) {
      yield { event: 'delta', data: { no, text: piece }, delayMs: 18 };
    }

    // 실제 백엔드 확인 결과: 구독 모드도 usage 는 실제 값을 주고 cost 만 null 이다.
    // 목도 그 모양을 따라간다(과금 판별은 cost 로만 한다).
    const usage = usageFor(no);
    const cost = subscription ? null : costFor(model, usage);
    if (usage) {
      totalUsage = {
        input_tokens: (totalUsage.input_tokens ?? 0) + (usage.input_tokens ?? 0),
        output_tokens: (totalUsage.output_tokens ?? 0) + (usage.output_tokens ?? 0),
        cache_creation_input_tokens:
          (totalUsage.cache_creation_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        cache_read_input_tokens:
          (totalUsage.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      };
    }
    if (cost?.total_usd) totalUsd += cost.total_usd;

    // 서버가 저장하는 것처럼 목 상태에도 남긴다.
    const fileSolutions = state.solutions.get(fileId) ?? new Map<number, Solution>();
    fileSolutions.set(no, {
      no,
      solution: text,
      usage,
      cost,
      truncated: false,
      created_at: nowIso(),
    });
    state.solutions.set(fileId, fileSolutions);
    const problem = (state.problems.get(fileId) ?? []).find((candidate) => candidate.no === no);
    if (problem) problem.has_solution = true;

    yield {
      event: 'done',
      data: { no, solution: text, usage, cost, truncated: false },
      delayMs: 30,
    };
  }

  const totalCost = subscription ? null : costFor(model, totalUsage);
  if (totalCost) {
    totalCost.total_usd = Number(totalUsd.toFixed(8));
    totalCost.total_krw = Number((totalUsd * state.env.usd_krw).toFixed(4));
  }
  yield {
    event: 'end',
    data: { total_usage: totalUsage, total_cost: totalCost },
    delayMs: 60,
  };
}

async function* chatScript(
  fileId: string,
  body: ChatRequest,
): AsyncGenerator<MockSseEvent, void, void> {
  const subscription = isSubscriptionCall(body.provider);
  const model = body.model ?? 'claude-opus-5';
  const reply = mockChatReply(body.message, body.problem_no ?? null);

  for (const piece of chunkText(reply, 20)) {
    yield { event: 'delta', data: { no: body.problem_no ?? null, text: piece }, delayMs: 22 };
  }

  // 구독도 usage 는 온다. cost 만 null.
  const usage = usageFor(body.problem_no ?? 1);
  const cost = subscription ? null : costFor(model, usage);

  const key = threadKey(fileId, body.problem_no ?? null);
  const history = state.chats.get(key) ?? [];
  history.push({ role: 'assistant', content: reply, created_at: nowIso(), usage, cost });
  state.chats.set(key, history);

  // 스레드가 길면(6턴 초과) 이력이 잘렸다고 알린다(계약 6-B).
  const truncatedBefore = Math.max(0, history.length - 6);

  yield {
    event: 'done',
    data: {
      no: body.problem_no ?? null,
      solution: reply,
      usage,
      cost,
      truncated: false,
      history_truncated: truncatedBefore > 0,
      truncated_before: truncatedBefore,
    },
    delayMs: 40,
  };
}

async function* convChatScript(
  conversation: MockConversation,
  body: ConversationChatRequest,
): AsyncGenerator<MockSseEvent, void, void> {
  const subscription = isSubscriptionCall(body.provider);
  const model = body.model ?? 'claude-opus-5';
  const problemNo = body.problem_no ?? null;
  const reply = mockChatReply(body.message, problemNo);

  for (const piece of chunkText(reply, 20)) {
    yield { event: 'delta', data: { text: piece }, delayMs: 22 };
  }

  const usage = usageFor(problemNo ?? 1);
  const cost = subscription ? null : costFor(model, usage);

  conversation.messages.push({
    role: 'assistant',
    content: reply,
    file_id: body.file_id ?? null,
    problem_no: problemNo,
    created_at: nowIso(),
    usage,
    cost,
  });
  conversation.updated_at = nowIso();

  const truncatedBefore = Math.max(0, conversation.messages.length - 12);

  yield {
    event: 'done',
    data: {
      content: reply,
      file_id: body.file_id ?? null,
      problem_no: problemNo,
      usage,
      cost,
      truncated: false,
      history_truncated: truncatedBefore > 0,
      truncated_before: truncatedBefore,
    },
    delayMs: 40,
  };
}

async function* variantScript(
  no: number,
  mode: VariantMode,
  opts: { provider?: string; model?: string },
): AsyncGenerator<MockSseEvent, void, void> {
  const subscription = isSubscriptionCall(opts.provider ?? 'subscription');
  const model = opts.model ?? 'claude-opus-5';
  const text = mockVariantText(no, mode);

  for (const piece of chunkText(text, 24)) {
    yield { event: 'delta', data: { no, text: piece }, delayMs: 18 };
  }

  const usage = usageFor(no);
  const cost = subscription ? null : costFor(model, usage);

  yield {
    event: 'done',
    data: { no, solution: text, usage, cost, truncated: false },
    delayMs: 30,
  };
}

/**
 * 판독(transcribe) 대본. **순서가 이 기능의 전부다** — 1차 디코딩(AI 호출 0회)을
 * 먼저 하고, 실패한 문항만 2차 AI 비전으로 보낸다.
 *
 * 그래서 디코딩으로 끝난 문항에는 delta 가 없고(즉시 `done`) usage/cost 도 없다.
 * AI 로 간 문항만 델타가 흐르고 사용량이 붙는다. 화면이 이 차이를 보여줘야 하므로
 * 목도 같은 모양으로 흘린다.
 */
async function* transcribeScript(
  targets: readonly number[],
  opts: { provider?: ProviderChoice; model?: string },
): AsyncGenerator<MockSseEvent, void, void> {
  const subscription = isSubscriptionCall(opts.provider ?? 'subscription');
  const model = opts.model ?? 'claude-opus-5';

  yield { event: 'start', data: { total: targets.length }, delayMs: 40 };

  let decodedCount = 0;
  let aiCount = 0;
  let unavailableCount = 0;

  for (const no of targets) {
    const decodable = mockDecodable(no);
    yield {
      event: 'problem',
      data: { no, status: 'running', route: decodable ? 'pua' : 'ai' },
      delayMs: 20,
    };

    if (decodable) {
      decodedCount += 1;
      yield {
        event: 'done',
        data: {
          no,
          source: 'pua',
          transcript: mockTranscriptText(no),
          note: null,
          decoded_count: decodedCount,
          ai_count: aiCount,
          usage: null,
          cost: null,
          truncated: false,
        },
        delayMs: 20,
      };
      continue;
    }

    // 2차: 디코딩이 못 한 문항만 AI 비전으로. 응답이 델타로 흐른다.
    aiCount += 1;
    const readable = mockAiReadable(no);
    const transcript = readable ? mockTranscriptText(no) : null;
    for (const piece of chunkText(transcript ?? MOCK_TRANSCRIPT_NOTE, 24)) {
      yield { event: 'delta', data: { no, text: piece }, delayMs: 12 };
    }
    if (!readable) unavailableCount += 1;
    const usage = usageFor(no);
    yield {
      event: 'done',
      data: {
        no,
        source: readable ? 'ai' : null,
        transcript,
        note: readable ? null : MOCK_TRANSCRIPT_NOTE,
        decoded_count: decodedCount,
        ai_count: aiCount,
        usage,
        cost: subscription ? null : costFor(model, usage),
        truncated: false,
      },
      delayMs: 20,
    };
  }

  yield {
    event: 'end',
    data: {
      total_usage: null,
      total_cost: null,
      decoded_count: decodedCount,
      ai_count: aiCount,
      unavailable_count: unavailableCount,
    },
    delayMs: 20,
  };
}

async function* streamFrom(
  script: AsyncGenerator<MockSseEvent, void, void>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  const stream = mockSseStream(script, signal);
  for await (const message of iterateSSE(stream, signal)) {
    if (signal?.aborted) return;
    yield toStreamEvent(message);
  }
}

export const mockClient: ApiClient = {
  async getEnv() {
    await sleep(LATENCY_MS);
    return { ...state.env, models: [...state.env.models] };
  },

  async getUsageSummary(): Promise<UsageSummaryResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    // 목에는 시간창 개념이 없으므로 저장된 풀이/채팅 usage 를 합쳐 스텁을 만든다.
    let tokens = 0;
    let calls = 0;
    const addUsage = (usage: Usage | null | undefined) => {
      if (!usage) return;
      tokens +=
        (usage.input_tokens ?? 0) +
        (usage.output_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      calls += 1;
    };
    for (const fileSolutions of state.solutions.values()) {
      for (const solution of fileSolutions.values()) addUsage(solution.usage);
    }
    for (const messages of state.chats.values()) {
      for (const message of messages) addUsage(message.usage);
    }
    for (const conversation of state.conversations) {
      for (const message of conversation.messages) addUsage(message.usage);
    }
    const window = { tokens, calls };
    return { windows: { last_24h: window, last_7_days: window, total: window } };
  },

  async login(password: string) {
    await sleep(LATENCY_MS);
    // 비번 미요구 환경이면 로그인은 무의미하게 성공시킨다(로컬 개발 흐름 보존).
    if (!authRequired()) return;
    if (password === MOCK_ACCESS_PASSWORD) return;
    throw new ApiError('unauthorized', '접속 비밀번호가 필요합니다.', null, 401);
  },

  async setApiKey(key: string) {
    await sleep(LATENCY_MS);
    requireAuth();
    if (key.trim() === '') {
      throw new ApiError('invalid_key', 'API 키를 입력하세요.', null, 400);
    }
    state.env = { ...state.env, api_key_set: true };
  },

  async deleteApiKey() {
    await sleep(LATENCY_MS);
    requireAuth();
    state.env = { ...state.env, api_key_set: false };
  },

  async getTree(section: Section = 'exam'): Promise<TreeResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    return {
      nodes: state.nodes
        .filter((node) => (node.section ?? 'exam') === section)
        .map((node) => ({ ...node })),
    };
  },

  async createFolder(name: string, parentId: string | null, section: Section = 'exam') {
    await sleep(LATENCY_MS);
    requireAuth();
    const trimmed = name.trim();
    if (trimmed === '') throw new ApiError('invalid_name', '폴더 이름을 입력하세요.', null, 400);
    let resolvedSection = section;
    if (parentId != null) {
      const parent = findNode(parentId);
      if (parent.type !== 'folder') {
        throw new ApiError('invalid_parent', '파일 안에는 폴더를 만들 수 없습니다.', null, 400);
      }
      // 부모의 섹션을 따른다(섹션을 넘나드는 구성 방지).
      resolvedSection = parent.section ?? 'exam';
    }
    const node: TreeNode = {
      id: nextId('folder'),
      type: 'folder',
      name: trimmed,
      parent_id: parentId,
      section: resolvedSection,
      created_at: nowIso(),
    };
    state.nodes = [...state.nodes, node];
    return { ...node };
  },

  async updateNode(id: string, patch: { name?: string; parent_id?: string | null }) {
    await sleep(LATENCY_MS);
    requireAuth();
    const node = findNode(id);

    if (patch.name != null) {
      const trimmed = patch.name.trim();
      if (trimmed === '') throw new ApiError('invalid_name', '이름을 입력하세요.', null, 400);
      node.name = trimmed;
    }

    if (patch.parent_id !== undefined) {
      const target = patch.parent_id;
      if (target === id) {
        throw new ApiError('invalid_move', '자기 자신 안으로는 옮길 수 없습니다.', null, 400);
      }
      if (target != null) {
        const parent = findNode(target);
        if (parent.type !== 'folder') {
          throw new ApiError('invalid_parent', '파일 안으로는 옮길 수 없습니다.', null, 400);
        }
        if (collectDescendantIds(id).includes(target)) {
          throw new ApiError('invalid_move', '하위 폴더 안으로는 옮길 수 없습니다.', null, 400);
        }
      }
      node.parent_id = target;
    }

    state.nodes = [...state.nodes];
    return { ...node };
  },

  async deleteNode(id: string) {
    await sleep(LATENCY_MS);
    requireAuth();
    findNode(id);
    const doomed = new Set([id, ...collectDescendantIds(id)]);
    state.nodes = state.nodes.filter((node) => !doomed.has(node.id));
    for (const doomedId of doomed) {
      state.problems.delete(doomedId);
      state.solutions.delete(doomedId);
      state.variants.delete(doomedId);
      state.transcripts.delete(doomedId);
      state.noteItems.delete(doomedId);
      // 이 노드로 시작하는 스레드 전부 삭제.
      for (const key of [...state.chats.keys()]) {
        if (key.startsWith(`${doomedId}::`)) state.chats.delete(key);
      }
    }
    // 계약 6-A: 원본 시험지를 지워도 오답노트 항목은 남기고 바로가기만 끊는다.
    for (const [noteId, items] of state.noteItems.entries()) {
      let changed = false;
      const next = items.map((item) => {
        if (item.source_node_id != null && doomed.has(item.source_node_id)) {
          changed = true;
          return { ...item, source_node_id: null, source_available: false, text: null };
        }
        return item;
      });
      if (changed) state.noteItems.set(noteId, next);
    }
  },

  async uploadFile(file: File, parentId: string | null) {
    // 업로드 + 추출은 시간이 걸린다 -> 진행 상태 확인용으로 좀 더 느리게.
    await sleep(900);
    requireAuth();
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      throw new ApiError(
        'unsupported_file',
        'PDF 파일만 업로드할 수 있습니다.',
        '시험지를 PDF 로 변환한 뒤 다시 시도하세요.',
        400,
      );
    }
    /*
      스캔본(사진만 있어 글자 정보가 0자인 PDF)을 목에서도 볼 수 있게 한다. 실서버는
      PDF 안을 들여다보고 판정하지만 목은 그럴 원본이 없으므로 **파일 이름**을 스위치로
      쓴다: 이름에 '스캔' 이 들어가면 0문항 + mode 'image' 로 만든다. 초기 트리에
      0문항 파일을 새로 끼우지 않은 이유는 그러면 트리 노드 수를 세는 기존 테스트가
      깨지기 때문이다(삭제 확인 창의 "모두 N개").
    */
    const scanned = file.name.includes('스캔');
    const problemCount = scanned ? 0 : MOCK_PROBLEM_COUNT;
    const node: TreeNode = {
      id: nextId('file'),
      type: 'file',
      name: file.name,
      parent_id: parentId,
      created_at: nowIso(),
      file: {
        pages: 7,
        problem_count: problemCount,
        mode: scanned ? 'image' : 'text',
        pua_ratio: scanned ? 0 : 0.019,
      },
    };
    state.nodes = [...state.nodes, node];
    state.problems.set(node.id, makeMockProblems(problemCount));
    return { ...node };
  },

  async getFile(id: string): Promise<FileDetail> {
    await sleep(LATENCY_MS);
    requireAuth();
    const node = findNode(id);
    if (node.type !== 'file') {
      throw new ApiError('not_a_file', '파일이 아닙니다.', null, 400);
    }
    const problems = state.problems.get(id) ?? [];
    return {
      node: { ...node },
      problems: problems.map((problem) => ({ ...problem })),
      extract_error: mockExtractError(node, problems.length),
    };
  },

  async reextractFile(id: string): Promise<ReextractResult> {
    // 업로드처럼 추출에 시간이 걸린다 -> 진행 상태 확인용으로 느리게.
    await sleep(900);
    requireAuth();
    const node = findNode(id);
    if (node.type !== 'file') {
      throw new ApiError('not_a_file', '파일이 아닙니다.', null, 400);
    }
    // 목은 같은 원본을 다시 읽는 셈이므로 문항은 그대로다. 풀이만 지운다.
    const deleted = state.solutions.get(id)?.size ?? 0;
    state.solutions.delete(id);
    // 재추출은 문항 번호가 바뀔 수 있으므로 판독본도 함께 버린다(실서버와 같다).
    state.transcripts.delete(id);
    const problems = state.problems.get(id) ?? [];
    for (const problem of problems) {
      problem.has_transcript = false;
      problem.transcript_source = null;
      problem.transcript_note = null;
    }
    return {
      node: { ...node },
      problems: problems.map((problem) => ({ ...problem })),
      extract_error: mockExtractError(node, problems.length),
      deleted_solutions: deleted,
    };
  },

  fileRawUrl() {
    // 목 모드에서는 실제 시험지 사본을 그대로 열어 pdf.js 렌더를 확인한다.
    // 프론트가 서빙하는 정적 자산이라 백엔드 게이트를 지나지 않는다 → 자격증명을 붙이지
    // 않는다(예전에는 ?access= 를 붙였지만, 비번을 URL 에 싣지 않기로 하면서 걷어냈다).
    return MOCK_PDF_PATH;
  },

  cropUrl(_id: string, no: number) {
    // 목 크롭은 data: URI 다. 요청 자체가 없으니 인증할 것도 없다.
    return mockCropUrl(no);
  },

  async exportDocument(
    target: ExportTarget,
    id: string,
    format: ExportFormat,
    include: ExportInclude,
    source?: string,
    body: ExportBody = 'image',
  ): Promise<{ blob: Blob; filename: string | null }> {
    await sleep(LATENCY_MS);
    requireAuth();
    const node = findNode(id);
    // 목은 실제 문서를 만들지 않는다. 다운로드 흐름(blob→a[download]) 확인용 더미.
    // 출처는 서버가 문서 끝에 넣는 값이라 목에서도 내용에만 반영한다.
    const type = format === 'hwpx' ? HWPX_MEDIA_TYPE : DOCX_MEDIA_TYPE;
    const footer = source == null || source.trim() === '' ? '' : `/${source.trim()}`;
    const blob = new Blob(
      [`mock ${format}: ${target}/${node.name}/${include}${footer}/body=${body}`],
      { type },
    );
    return { blob, filename: null };
  },

  async getVariants(id: string): Promise<VariantsResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    findNode(id);
    // 실서버와 같이 완료된 변형을 돌려준다. 이게 비어 있으면 프론트가 저장본을
    // 못 찾아 재생성을 걸게 되므로(그리고 실서버는 그걸 400 으로 막으므로)
    // 목도 같은 사실을 말해야 한다.
    const saved = [...(state.variants.get(id)?.values() ?? [])];
    saved.sort((a, b) => a.no - b.no || VARIANT_ORDER[a.mode] - VARIANT_ORDER[b.mode]);
    return { variants: saved };
  },

  async getTranscripts(id: string): Promise<TranscriptsResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    findNode(id);
    // 실서버처럼 판독본도 이유도 없는 문항(= 아직 판독하지 않음)은 빼고 준다.
    const saved = [...(state.transcripts.get(id)?.values() ?? [])]
      .filter((item) => item.transcript != null || item.transcript_note != null)
      .map((item) => ({ ...item }))
      .sort((a, b) => a.no - b.no);
    return { transcripts: saved };
  },

  async saveTranscript(id: string, no: number, text: string): Promise<Transcript> {
    await sleep(LATENCY_MS);
    requireAuth();
    findNode(id);
    // 실서버(`service.save_transcript`)와 같은 규칙: 앞뒤 공백을 떼고,
    // 남는 게 없으면 판독본을 **지운다**(출처·이유도 함께 비운다).
    const cleaned = text.trim();
    if (cleaned.length > MOCK_TRANSCRIPT_MAX_LENGTH) {
      throw new ApiError(
        'transcript_too_long',
        `판독본이 너무 깁니다. ${MOCK_TRANSCRIPT_MAX_LENGTH.toLocaleString()}자 이내로 줄여 주세요.`,
        `현재 ${cleaned.length.toLocaleString()}자입니다.`,
        400,
      );
    }
    if ((state.problems.get(id) ?? []).every((problem) => problem.no !== no)) {
      throw new ApiError('not_found', `${no}번 문항이 없습니다.`, null, 404);
    }
    const next: Transcript = {
      no,
      transcript: cleaned === '' ? null : cleaned,
      transcript_source: cleaned === '' ? null : 'manual',
      transcript_note: null,
    };
    writeMockTranscript(id, next);
    return { ...next };
  },

  async getSolutions(id: string): Promise<SolutionsResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    const solutions = state.solutions.get(id);
    if (!solutions) return { solutions: [] };
    return {
      solutions: [...solutions.values()]
        .map((solution) => ({ ...solution }))
        .sort((a, b) => a.no - b.no),
    };
  },

  async saveSolutionContent(
    id: string,
    no: number,
    content: string,
    usage: Usage | null = null,
    _source: string | null = null,
  ): Promise<Solution> {
    await sleep(LATENCY_MS);
    requireAuth();
    findNode(id);
    if (content.trim() === '') {
      throw new ApiError('invalid_content', '저장할 풀이 내용이 없습니다.', null, 400);
    }
    const solution: Solution = {
      no,
      solution: content,
      usage: usage ?? null,
      cost: null,
      truncated: false,
      created_at: nowIso(),
    };
    const fileSolutions = state.solutions.get(id) ?? new Map<number, Solution>();
    fileSolutions.set(no, solution);
    state.solutions.set(id, fileSolutions);
    const problem = (state.problems.get(id) ?? []).find((candidate) => candidate.no === no);
    if (problem) problem.has_solution = true;
    return { ...solution };
  },

  async getChatHistory(id: string, problemNo: number | null = null): Promise<ChatHistoryResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    const key = threadKey(id, problemNo);
    return { messages: (state.chats.get(key) ?? []).map((message) => ({ ...message })) };
  },

  async getChatThreads(id: string): Promise<ThreadsResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    const threads = [];
    for (const [key, messages] of state.chats.entries()) {
      if (!key.startsWith(`${id}::`) || messages.length === 0) continue;
      const suffix = key.slice(id.length + 2);
      const problemNo = suffix === 'global' ? null : Number(suffix);
      const last = messages[messages.length - 1];
      threads.push({
        problem_no: problemNo,
        turns: messages.filter((m) => m.role === 'user').length,
        updated_at: last?.created_at ?? nowIso(),
      });
    }
    threads.sort((a, b) => (a.problem_no ?? -1) - (b.problem_no ?? -1));
    return { threads };
  },

  async clearChat(id: string, problemNo: number | null = null) {
    await sleep(LATENCY_MS);
    requireAuth();
    state.chats.delete(threadKey(id, problemNo));
  },

  async createConversation(title: string | null = null): Promise<Conversation> {
    await sleep(LATENCY_MS);
    requireAuth();
    const trimmed = title?.trim() ?? '';
    const now = nowIso();
    const conversation: MockConversation = {
      id: nextId('conv'),
      title: trimmed === '' ? '새 대화' : trimmed,
      created_at: now,
      updated_at: now,
      // 사용자가 제목을 지정하지 않았을 때만 첫 메시지로 자동 제목을 붙인다.
      autoTitle: trimmed === '',
      messages: [],
    };
    state.conversations.push(conversation);
    return toConversationOut(conversation);
  },

  async getConversations(): Promise<ConversationsResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    const conversations = [...state.conversations]
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
      .map(toConversationOut);
    return { conversations };
  },

  async renameConversation(id: string, title: string): Promise<Conversation> {
    await sleep(LATENCY_MS);
    requireAuth();
    const conversation = findConversation(id);
    const trimmed = title.trim();
    if (trimmed === '') throw new ApiError('invalid_name', '대화 이름을 입력하세요.', null, 400);
    conversation.title = trimmed;
    // 사용자가 직접 정한 제목은 자동 제목으로 덮이지 않는다.
    conversation.autoTitle = false;
    return toConversationOut(conversation);
  },

  async deleteConversation(id: string) {
    await sleep(LATENCY_MS);
    requireAuth();
    findConversation(id);
    state.conversations = state.conversations.filter((candidate) => candidate.id !== id);
  },

  async getConversationMessages(id: string): Promise<ConversationMessagesResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    const conversation = findConversation(id);
    return { messages: conversation.messages.map((message) => ({ ...message })) };
  },

  conversationChat(id: string, body: ConversationChatRequest, signal?: AbortSignal) {
    requireAuth();
    const conversation = findConversation(id);
    const firstMessage = conversation.messages.length === 0;
    conversation.messages.push({
      role: 'user',
      content: body.message,
      file_id: body.file_id ?? null,
      problem_no: body.problem_no ?? null,
      created_at: nowIso(),
    });
    // 첫 사용자 메시지면 자동 제목을 붙인다(직접 지정한 제목은 건드리지 않는다).
    if (firstMessage && conversation.autoTitle) {
      conversation.title = body.message.trim().slice(0, 40) || '새 대화';
      conversation.autoTitle = false;
    }
    conversation.updated_at = nowIso();
    return streamFrom(convChatScript(conversation, body), signal);
  },

  async createNote(name: string, parentId: string | null) {
    await sleep(LATENCY_MS);
    requireAuth();
    const trimmed = name.trim();
    if (trimmed === '') throw new ApiError('invalid_name', '노트 이름을 입력하세요.', null, 400);
    let section: Section = 'note';
    if (parentId != null) {
      const parent = findNode(parentId);
      if (parent.type !== 'folder') {
        throw new ApiError('invalid_parent', '파일 안에는 노트를 만들 수 없습니다.', null, 400);
      }
      section = parent.section ?? 'note';
    }
    const node: TreeNode = {
      id: nextId('note'),
      type: 'file',
      name: trimmed,
      parent_id: parentId,
      section,
      file: null,
      created_at: nowIso(),
    };
    state.nodes = [...state.nodes, node];
    state.noteItems.set(node.id, []);
    return { ...node };
  },

  async getNote(id: string): Promise<NoteDetail> {
    await sleep(LATENCY_MS);
    requireAuth();
    const node = findNode(id);
    const items = state.noteItems.get(id) ?? [];
    return { node: { ...node }, items: items.map((item) => ({ ...item })) };
  },

  async addNoteItems(
    noteId: string,
    sourceNodeId: string,
    problemNumbers: number[],
    memo: string | null = null,
  ): Promise<AddNoteItemsResult> {
    await sleep(LATENCY_MS);
    requireAuth();
    findNode(noteId);
    const source = state.nodes.find((node) => node.id === sourceNodeId);
    const sourceName = source?.name ?? '(알 수 없는 시험지)';
    const items = state.noteItems.get(noteId) ?? [];
    const added: number[] = [];
    const skipped: number[] = [];
    for (const no of problemNumbers) {
      const exists = items.some(
        (item) => item.source_node_id === sourceNodeId && item.problem_no === no,
      );
      if (exists) {
        skipped.push(no);
        continue;
      }
      const itemId = nextId('item');
      items.push({
        id: itemId,
        source_node_id: sourceNodeId,
        source_name: sourceName,
        problem_no: no,
        crop_url: mockCropUrl(no),
        text: source != null ? mockProblemText(no) : null,
        memo,
        created_at: nowIso(),
        source_available: source != null,
      });
      added.push(no);
    }
    state.noteItems.set(noteId, items);
    return { added, skipped };
  },

  async deleteNoteItem(noteId: string, itemId: string) {
    await sleep(LATENCY_MS);
    requireAuth();
    const items = state.noteItems.get(noteId) ?? [];
    state.noteItems.set(
      noteId,
      items.filter((item) => item.id !== itemId),
    );
  },

  noteCropUrl(_noteId: string, itemId: string) {
    // 목에서는 항목 id 뒤 숫자를 번호처럼 써서 플레이스홀더를 만든다.
    // data: URI 라 네트워크 요청이 없다 → 토큰/비번 모두 무의미하다.
    const match = /(\d+)/.exec(itemId);
    return mockCropUrl(match ? Number(match[1]) % 22 || 1 : 1);
  },

  chat(id: string, body: ChatRequest, signal?: AbortSignal) {
    requireAuth();
    const key = threadKey(id, body.problem_no ?? null);
    const history = state.chats.get(key) ?? [];
    history.push({ role: 'user', content: body.message, created_at: nowIso() });
    state.chats.set(key, history);
    return streamFrom(chatScript(id, body), signal);
  },

  async createJob(body: JobCreateRequest): Promise<JobCreated> {
    await sleep(LATENCY_MS);
    requireAuth();
    const node = findNode(body.node_id);

    // 같은 **대상** 을 이미 처리 중이면 그것을 돌려준다(버튼 두 번 방지).
    // 시험지 단위로만 막으면 다른 문항·다른 변형이 통째로 무시된다.
    for (const existing of state.jobs.values()) {
      if (
        existing.record.node_id !== body.node_id ||
        existing.record.kind !== body.kind ||
        (existing.record.status !== 'queued' && existing.record.status !== 'running')
      ) {
        continue;
      }
      if (overlapsTarget(existing, body)) {
        return { job: { ...existing.record }, existing: true, position: 0 };
      }
    }

    const script: MockSseEvent[] = [];
    let total = 0;
    let solveTargets: number[] = [];
    let variantNumbers: number[] = [];
    let transcribeTargets: number[] = [];
    if (body.kind === 'transcribe') {
      const problems = state.problems.get(body.node_id) ?? [];
      const requested =
        body.problem_numbers == null || body.problem_numbers.length === 0
          ? problems.map((problem) => problem.no)
          : body.problem_numbers;
      // 실서버(`plan_transcribe_job`)와 같은 스킵 규칙: force 가 아니면 이미
      // 판독본이 있는 문항을 뺀다. **빈 판독본은 세지 않는다**(이유만 남은 문항은
      // 다시 판독 대상이다) — `storage.transcribed_numbers` 와 같은 규칙이다.
      const targets = body.force
        ? requested
        : requested.filter((no) => savedTranscript(body.node_id, no)?.transcript == null);
      if (targets.length === 0) {
        throw new ApiError(
          'already_transcribed',
          '요청한 문항은 이미 모두 텍스트로 옮겨져 있습니다.',
          '다시 판독하려면 "다시 판독" 을 눌러 주세요.',
          400,
        );
      }
      transcribeTargets = targets;
      total = targets.length;
      for await (const event of transcribeScript(targets, {
        provider: body.provider,
        model: body.model,
      })) {
        script.push(event);
      }
    } else if (body.kind === 'solve') {
      const problems = state.problems.get(body.node_id) ?? [];
      const solved = state.solutions.get(body.node_id) ?? new Map<number, Solution>();
      const requested =
        body.problem_numbers == null || body.problem_numbers.length === 0
          ? problems.map((problem) => problem.no)
          : body.problem_numbers;
      const targets = body.force ? requested : requested.filter((no) => !solved.has(no));
      solveTargets = targets;
      if (targets.length === 0) {
        throw new ApiError(
          'already_solved',
          '요청한 문항은 이미 모두 풀려 있습니다.',
          '다시 풀려면 "다시 풀기" 를 눌러 주세요.',
          400,
        );
      }
      total = targets.length;
      for await (const event of solveScript(body.node_id, {
        problem_numbers: targets,
        provider: body.provider,
        model: body.model,
        effort: body.effort,
      })) {
        script.push(event);
      }
    } else {
      // 다중 선택은 problem_numbers 로 온다. 없으면 기존 단일 경로(no).
      const requested =
        body.problem_numbers && body.problem_numbers.length > 0
          ? [...new Set(body.problem_numbers)]
          : [body.no ?? 1];
      const modes = body.modes ?? ['number'];
      // 실서버와 같은 스킵 규칙: force 가 아니면 이미 만든 (문항, 유형)은 뺀다.
      const made = state.variants.get(body.node_id);
      const pairs: Array<{ no: number; mode: VariantMode }> = [];
      for (const no of requested) {
        for (const mode of modes) {
          if (!body.force && made?.has(variantSlot(no, mode))) continue;
          pairs.push({ no, mode });
        }
      }
      if (pairs.length === 0) {
        throw new ApiError(
          'already_generated',
          '요청한 변형은 이미 모두 만들어져 있습니다.',
          '다시 만들려면 "다시 생성" 을 눌러 주세요.',
          400,
        );
      }
      variantNumbers = [...new Set(pairs.map((pair) => pair.no))];
      total = pairs.length;
      script.push({ event: 'start', data: { total }, delayMs: 40 });
      for (const { no, mode } of pairs) {
        for await (const event of variantScript(no, mode, {
          provider: body.provider,
          model: body.model,
        })) {
          const data = (event.data ?? {}) as Record<string, unknown>;
          script.push({ ...event, data: { ...data, mode } });
        }
      }
      script.push({
        event: 'end',
        data: { total_usage: null, total_cost: null },
        delayMs: 20,
      });
    }

    const id = `job-${++state.counter}`;
    const record: Job = {
      id,
      kind: body.kind,
      node_id: body.node_id,
      node_name: node.name,
      status: 'running',
      total,
      done_count: 0,
      current_no: null,
      error: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const job: MockJob = {
      record,
      targets:
        body.kind === 'solve'
          ? { numbers: solveTargets }
          : body.kind === 'transcribe'
            ? { numbers: transcribeTargets }
            : { numbers: variantNumbers, modes: body.modes ?? ['number'] },
      force: body.force === true,
      script,
      cursor: 0,
      partialText: '',
      canceled: false,
      timer: null,
      listeners: new Set(),
    };
    state.jobs.set(id, job);
    startMockJob(job);
    return { job: { ...record }, existing: false, position: 0 };
  },

  async listJobs(): Promise<JobsResponse> {
    await sleep(LATENCY_MS);
    requireAuth();
    const all = [...state.jobs.values()].map((job) => ({ ...job.record }));
    return {
      active: all.filter((job) => job.status === 'queued' || job.status === 'running'),
      recent: all.filter((job) => job.status !== 'queued' && job.status !== 'running'),
    };
  },

  jobEvents(jobId: string, signal?: AbortSignal) {
    requireAuth();
    return mockJobEvents(jobId, signal);
  },

  async cancelJob(jobId: string) {
    await sleep(LATENCY_MS);
    requireAuth();
    const job = state.jobs.get(jobId);
    if (!job) throw new ApiError('not_found', '작업을 찾을 수 없습니다.', null, 404);
    job.canceled = true;
  },
};

/** 진행 중 작업과 새 요청의 대상이 겹치는지(백엔드 `_find_overlapping_job` 과 같은 규칙). */
function overlapsTarget(existing: MockJob, body: JobCreateRequest): boolean {
  if (body.kind === 'solve' || body.kind === 'transcribe') {
    if (body.problem_numbers == null) return true;
    const wanted = new Set(body.problem_numbers);
    return existing.targets.numbers?.some((no) => wanted.has(no)) ?? false;
  }
  const wantedNumbers = new Set(
    body.problem_numbers && body.problem_numbers.length > 0
      ? body.problem_numbers
      : [body.no ?? 1],
  );
  if (!existing.targets.numbers?.some((no) => wantedNumbers.has(no))) return false;
  const wanted = new Set(body.modes ?? ['number']);
  return existing.targets.modes?.some((mode) => wanted.has(mode)) ?? false;
}

/** 목 작업 워커. 구독자가 없어도 대본을 소비해 진행한다(실서버와 같은 성질). */
function startMockJob(job: MockJob): void {
  const step = () => {
    if (job.canceled) {
      finishMockJob(job, 'canceled');
      return;
    }
    const event = job.script[job.cursor];
    if (event === undefined) {
      finishMockJob(job, 'done');
      return;
    }
    job.cursor += 1;
    applyMockEvent(job, event);
    for (const listener of job.listeners) listener(event);
    if (event.event === 'end') finishMockJob(job, 'done');
  };
  // 실제 스트리밍처럼 조금씩 진행시킨다.
  job.timer = setInterval(step, 12);
}

function applyMockEvent(job: MockJob, event: MockSseEvent): void {
  const data = event.data as Record<string, unknown>;
  if (event.event === 'problem') {
    job.record.current_no = typeof data.no === 'number' ? data.no : null;
    job.partialText = '';
  } else if (event.event === 'delta') {
    job.partialText += typeof data.text === 'string' ? data.text : '';
  } else if (event.event === 'done' || event.event === 'error') {
    job.record.done_count += 1;
    job.partialText = '';
    // 변형도 완료 시점에 목 저장소에 남긴다(실서버가 문항마다 저장하는 것과 같다).
    if (job.record.kind === 'variant' && event.event === 'done') {
      const no = typeof data.no === 'number' ? data.no : null;
      const mode = data.mode as VariantMode | undefined;
      if (no != null && mode) {
        const variants = state.variants.get(job.record.node_id) ?? new Map<string, Variant>();
        variants.set(variantSlot(no, mode), {
          no,
          mode,
          text: typeof data.solution === 'string' ? data.solution : '',
          usage: (data.usage as Usage | null) ?? null,
          cost: (data.cost as Cost | null) ?? null,
          created_at: nowIso(),
        });
        state.variants.set(job.record.node_id, variants);
      }
    }
    // 판독본도 문항마다 저장한다. 실서버와 같은 두 규칙을 지킨다.
    //   1. `불가` 판정은 **이유만** 남기고 이미 확보한 전문을 지우지 않는다.
    //      AI 판정은 비결정적이라 그 변동으로 데이터를 잃으면 안 된다.
    //   2. 사용자가 고친 판독본(`manual`)은 force 없는 재실행이 덮지 않는다.
    if (job.record.kind === 'transcribe' && event.event === 'done') {
      const no = typeof data.no === 'number' ? data.no : null;
      const nodeId = job.record.node_id;
      const current = no == null ? undefined : savedTranscript(nodeId, no);
      const protectedManual = !job.force && current?.transcript_source === 'manual';
      if (no != null && !protectedManual) {
        const transcript = typeof data.transcript === 'string' ? data.transcript : null;
        const note = typeof data.note === 'string' ? data.note : null;
        const source = typeof data.source === 'string' ? data.source : null;
        writeMockTranscript(
          nodeId,
          transcript == null
            ? {
                no,
                transcript: current?.transcript ?? null,
                transcript_source: current?.transcript_source ?? null,
                transcript_note: note,
              }
            : { no, transcript, transcript_source: source, transcript_note: note },
        );
      }
    }
    // 풀이는 목 저장소에도 남긴다(실서버가 문항마다 저장하는 것과 같다).
    if (job.record.kind === 'solve' && event.event === 'done') {
      const no = typeof data.no === 'number' ? data.no : null;
      if (no != null) {
        const solutions =
          state.solutions.get(job.record.node_id) ?? new Map<number, Solution>();
        solutions.set(no, {
          no,
          solution: typeof data.solution === 'string' ? data.solution : '',
          usage: (data.usage as Usage | null) ?? null,
          cost: (data.cost as Cost | null) ?? null,
          truncated: false,
          created_at: nowIso(),
        });
        state.solutions.set(job.record.node_id, solutions);
      }
    }
  }
  job.record.updated_at = nowIso();
}

function finishMockJob(job: MockJob, status: Job['status']): void {
  if (job.timer != null) {
    clearInterval(job.timer);
    job.timer = null;
  }
  if (job.record.status !== 'running' && job.record.status !== 'queued') return;
  job.record.status = status;
  job.record.current_no = null;
  job.record.updated_at = nowIso();
  const end: MockSseEvent = {
    event: 'end',
    data: { total_usage: null, total_cost: null, status },
    delayMs: 0,
  };
  for (const listener of job.listeners) {
    listener(end);
    listener(null);
  }
  job.listeners.clear();
}

/** 작업 구독: snapshot 을 먼저 주고 이후 이벤트를 흘린다. */
async function* mockJobEvents(
  jobId: string,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent, void, void> {
  const job = state.jobs.get(jobId);
  if (!job) throw new ApiError('not_found', '작업을 찾을 수 없습니다.', null, 404);

  yield {
    type: 'snapshot',
    status: job.record.status,
    total: job.record.total,
    done_count: job.record.done_count,
    current_no: job.record.current_no,
    partial_text: job.partialText,
  };
  if (job.record.status !== 'running' && job.record.status !== 'queued') {
    yield { type: 'end', total_usage: null, total_cost: null, status: job.record.status };
    return;
  }

  const queue: (MockSseEvent | null)[] = [];
  let wake: (() => void) | null = null;
  const listener = (event: MockSseEvent | null) => {
    queue.push(event);
    wake?.();
  };
  job.listeners.add(listener);
  try {
    while (!signal?.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const event = queue.shift();
      if (event === undefined) continue;
      if (event === null) return;
      yield toStreamEvent({
        event: event.event,
        data: JSON.stringify(event.data),
        id: null,
        retry: null,
      });
      if (event.event === 'end') return;
    }
  } finally {
    job.listeners.delete(listener);
  }
}
