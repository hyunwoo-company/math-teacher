/**
 * 목 데이터. 백엔드가 없어도 UI 전체 흐름을 돌릴 수 있게 한다.
 * `NEXT_PUBLIC_MOCK=1` 일 때만 쓰인다.
 *
 * 구성: 2단 중첩 폴더 + PDF 파일 1개 + 문제 22개.
 */

import type { EnvResponse, Problem, TreeNode } from '@/types/api';

/** 목 모드에서 PDF 뷰어가 열 파일. `public/mock/sample.pdf` (실제 시험지 사본). */
export const MOCK_PDF_PATH = '/mock/sample.pdf';

export const MOCK_PAGES = 7;
export const MOCK_PROBLEM_COUNT = 22;

/** A4(595x841) 2열 4행 배치로 문제 bbox 를 만든다. 실제 추출기와 좌표계(PDF pt, page 1-base)를 맞춘다. */
export function makeMockProblems(count = MOCK_PROBLEM_COUNT): Problem[] {
  const problems: Problem[] = [];
  for (let no = 1; no <= count; no += 1) {
    const index = no - 1;
    const page = Math.floor(index / 4) + 1;
    const slot = index % 4;
    const column = slot % 2;
    const row = Math.floor(slot / 2);
    const x0 = column === 0 ? 40 : 303;
    const x1 = column === 0 ? 292 : 555;
    const y0 = row === 0 ? 70 : 450;
    const y1 = row === 0 ? 430 : 800;
    problems.push({
      no,
      page: Math.min(page, MOCK_PAGES),
      bbox: [x0, y0, x1, y1],
      image_w: Math.round((x1 - x0) * 2),
      image_h: Math.round((y1 - y0) * 2),
      has_solution: false,
    });
  }
  return problems;
}

export const MOCK_FILE_ID = 'file-punmun';
export const MOCK_NOTE_STUDENT_FOLDER = 'note-folder-student';
export const MOCK_NOTE_ID = 'note-file-midterm';

/** 2단 중첩 폴더 + 파일 1개 (시험지 섹션). */
export function makeMockNodes(): TreeNode[] {
  return [
    {
      id: 'folder-2026-1',
      type: 'folder',
      name: '2026-1학기',
      parent_id: null,
      section: 'exam',
      created_at: '2026-07-20T09:00:00+09:00',
    },
    {
      id: 'folder-common1',
      type: 'folder',
      name: '공통수학1',
      parent_id: 'folder-2026-1',
      section: 'exam',
      created_at: '2026-07-20T09:05:00+09:00',
    },
    {
      id: 'folder-calculus',
      type: 'folder',
      name: '미적분',
      parent_id: 'folder-2026-1',
      section: 'exam',
      created_at: '2026-07-20T09:06:00+09:00',
    },
    {
      id: 'folder-mock-exam',
      type: 'folder',
      name: '모의고사',
      parent_id: null,
      section: 'exam',
      created_at: '2026-07-21T10:00:00+09:00',
    },
    {
      id: 'folder-june',
      type: 'folder',
      name: '6월',
      parent_id: 'folder-mock-exam',
      section: 'exam',
      created_at: '2026-07-21T10:01:00+09:00',
    },
    {
      id: MOCK_FILE_ID,
      type: 'file',
      name: '[2026-1-1-M][공수1][풍문고].pdf',
      parent_id: 'folder-common1',
      section: 'exam',
      created_at: '2026-07-22T14:32:00+09:00',
      file: {
        pages: MOCK_PAGES,
        problem_count: MOCK_PROBLEM_COUNT,
        mode: 'text',
        pua_ratio: 0.021,
      },
    },
  ];
}

/** 오답노트 섹션 초기 노드: 학생 폴더 1개 + 그 안의 노트 1개. */
export function makeMockNoteNodes(): TreeNode[] {
  return [
    {
      id: MOCK_NOTE_STUDENT_FOLDER,
      type: 'folder',
      name: '이현우',
      parent_id: null,
      section: 'note',
      created_at: '2026-07-23T09:00:00+09:00',
    },
    {
      id: MOCK_NOTE_ID,
      type: 'file',
      name: '중간고사 오답',
      parent_id: MOCK_NOTE_STUDENT_FOLDER,
      section: 'note',
      created_at: '2026-07-23T09:01:00+09:00',
      file: null,
    },
  ];
}

const MOCK_CLI_PATH = 'C:\\Users\\hyunwoo\\.local\\bin\\claude.exe';

/**
 * 목 환경. `NEXT_PUBLIC_MOCK_MODE` 로 시나리오를 바꿔 UI 분기를 확인할 수 있다.
 *  - (기본) `desktop`     : 구독 가능 -> 구독 사용 표기
 *  - `web`                : 웹 배포(구조적으로 구독 불가) -> API 키 안내
 *  - `desktop-nokey`      : Claude Code 미설치 -> 설치 안내
 *  - `desktop-nologin`    : Claude Code 설치됐지만 미로그인 -> 로그인 안내
 *  - `desktop-disabled`   : 환경변수로 구독 강제 비활성화
 *  - `legacy`             : reason 필드를 주지 않는 구버전 백엔드(방어 로직 확인용)
 *  - `agy`                : agy(무과금) + 구독 모두 가능, providers/default_provider 제공
 *  - `agy-only`           : agy 만 가능(Claude CLI 없음) -> Claude 모델 선택지 비활성 확인
 */
const CLAUDE_MODELS: EnvResponse['models'] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5', input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', input_usd_per_mtok: 1, output_usd_per_mtok: 5 },
];

const AGY_MODELS = [
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash (빠름)', default: true },
  { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro (정확)' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
];

function claudeProviderModels() {
  return CLAUDE_MODELS.map((model) => ({
    id: model.id,
    label: model.label,
    input_usd_per_mtok: model.input_usd_per_mtok,
    output_usd_per_mtok: model.output_usd_per_mtok,
  }));
}

export function makeMockEnv(): EnvResponse {
  const scenario = process.env.NEXT_PUBLIC_MOCK_MODE ?? 'desktop';
  const base = { api_key_set: false, models: CLAUDE_MODELS, usd_krw: 1400 } as const;

  switch (scenario) {
    case 'web':
      return {
        ...base,
        mode: 'web',
        subscription: { available: false, cli_path: null, reason: 'web_mode' },
      };
    case 'desktop-nokey':
      return {
        ...base,
        mode: 'desktop',
        subscription: { available: false, cli_path: null, reason: 'cli_missing' },
      };
    case 'desktop-nologin':
      return {
        ...base,
        mode: 'desktop',
        subscription: { available: false, cli_path: MOCK_CLI_PATH, reason: 'not_logged_in' },
      };
    case 'desktop-disabled':
      return {
        ...base,
        mode: 'desktop',
        subscription: { available: false, cli_path: null, reason: 'disabled' },
      };
    case 'legacy':
      // reason 을 아예 주지 않는 구버전 백엔드(실제로 8100 이 한동안 이 상태였다).
      return {
        ...base,
        mode: 'desktop',
        subscription: { available: false, cli_path: MOCK_CLI_PATH },
      };
    case 'agy':
      // agy + 구독 둘 다 가능. providers 구조 + default_provider=agy.
      return {
        ...base,
        mode: 'desktop',
        subscription: { available: true, cli_path: MOCK_CLI_PATH, reason: 'ok' },
        providers: {
          agy: { available: true, reason: 'ok', models: AGY_MODELS },
          subscription: {
            available: true,
            reason: 'ok',
            cli_path: MOCK_CLI_PATH,
            models: claudeProviderModels(),
          },
          // agy 시나리오에서도 API 키 경로를 선택할 수 있게 둔다(사용자가 키를 넣은 경우).
          apikey: { available: true, models: claudeProviderModels() },
        },
        default_provider: 'agy',
      };
    case 'agy-only':
      // agy 만 가능. Claude CLI 없음 -> Claude 모델 선택지 비활성/숨김 확인용.
      return {
        ...base,
        mode: 'desktop',
        subscription: { available: false, cli_path: null, reason: 'cli_missing' },
        providers: {
          agy: { available: true, reason: 'ok', models: AGY_MODELS },
          subscription: {
            available: false,
            reason: 'cli_missing',
            cli_path: null,
            models: claudeProviderModels(),
          },
          apikey: { available: false, models: claudeProviderModels() },
        },
        default_provider: 'agy',
      };
    default:
      return {
        ...base,
        mode: 'desktop',
        subscription: { available: true, cli_path: MOCK_CLI_PATH, reason: 'ok' },
      };
  }
}

/** 크롭 썸네일 대신 쓰는 플레이스홀더(SVG data URI). 네트워크를 타지 않는다. */
export function mockCropUrl(no: number): string {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="252" height="360" viewBox="0 0 252 360">',
    '<rect width="252" height="360" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>',
    `<text x="16" y="44" font-family="sans-serif" font-size="26" fill="#0f172a">${no}.</text>`,
    '<rect x="16" y="70" width="200" height="10" rx="5" fill="#e2e8f0"/>',
    '<rect x="16" y="96" width="220" height="10" rx="5" fill="#e2e8f0"/>',
    '<rect x="16" y="122" width="150" height="10" rx="5" fill="#e2e8f0"/>',
    '<rect x="16" y="164" width="120" height="34" rx="4" fill="#eef2f7"/>',
    '<rect x="16" y="220" width="180" height="10" rx="5" fill="#e2e8f0"/>',
    '<rect x="16" y="246" width="140" height="10" rx="5" fill="#e2e8f0"/>',
    '<text x="126" y="330" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#94a3b8">',
    '크롭 미리보기 (목 데이터)</text>',
    '</svg>',
  ].join('');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 목 풀이 본문. inline `\(...\)` 과 display `\[...\]` 를 모두 포함한다. */
export function mockSolutionText(no: number): string {
  return [
    `**1단계.** ${no}번 문제의 조건을 식으로 정리한다.`,
    `주어진 이차식을 \\(f(x) = x^2 + ${no}\\) 라 하자.`,
    '',
    '**2단계.** 판별식을 계산한다.',
    '\\[ D = b^2 - 4ac = 0^2 - 4 \\cdot 1 \\cdot ' + no + ' = -' + 4 * no + ' \\]',
    `\\(D < 0\\) 이므로 실근이 없다.`,
    '',
    '**3단계.** 비율을 정리하면 다음과 같다.',
    '\\[ \\frac{a}{b} = \\frac{' + no + '}{' + (no + 1) + '} \\]',
    '',
    `따라서 \\(x^2 + 1 > 0\\) 이 항상 성립하고, 답은 **${(no % 5) + 1}번** 이다.`,
  ].join('\n');
}

/** 목 채팅 답변. */
export function mockChatReply(question: string, problemNo: number | null): string {
  const target = problemNo == null ? '이 시험지 전체' : `${problemNo}번 문제`;
  return [
    `${target}에 대한 질문을 확인했습니다. 요청: "${question.trim()}"`,
    '',
    `핵심은 \\(x^2 + 1\\) 이 항상 양수라는 점입니다. 완전제곱식으로 보면`,
    '\\[ x^2 + 1 = \\left(x - 0\\right)^2 + 1 \\ge 1 > 0 \\]',
    '이므로 실수 전체에서 부호가 바뀌지 않습니다.',
    '',
    '**정리**: 판별식 \\(D = -4 < 0\\) 이라 실근이 없고, 그래프는 x축과 만나지 않습니다.',
  ].join('\n');
}
