/**
 * AI 응답 텍스트에서 수식 구간을 분리하고 KaTeX 로 렌더한다.
 *
 * CDN 을 쓰지 않는다(데스크톱 오프라인 대비). `katex` npm 패키지 + 로컬 CSS/폰트만 사용.
 *
 * 지원 구분자
 *  - display : `$$...$$`, `\[...\]`
 *  - inline  : `$...$`,   `\(...\)`
 * 닫는 구분자를 못 찾으면 수식으로 보지 않고 원문 텍스트로 남긴다(깨진 출력 방지).
 */

import katex from 'katex';

export type MathSegment =
  | { kind: 'text'; value: string }
  | { kind: 'math'; value: string; display: boolean };

interface Delimiter {
  open: string;
  close: string;
  display: boolean;
}

// 긴 구분자를 먼저 검사해야 `$$` 가 `$` 로 오인되지 않는다.
const DELIMITERS: readonly Delimiter[] = [
  { open: '$$', close: '$$', display: true },
  { open: '\\[', close: '\\]', display: true },
  { open: '\\(', close: '\\)', display: false },
  { open: '$', close: '$', display: false },
];

/** 수식 안이 비었거나 빈 줄을 포함하면 수식으로 보지 않는다(오탐 방지). */
function looksLikeMath(body: string): boolean {
  if (body.trim() === '') return false;
  return !/\n[ \t]*\n/.test(body);
}

/**
 * 텍스트를 텍스트/수식 세그먼트로 나눈다.
 * `\$` 처럼 이스케이프된 달러는 수식 시작으로 보지 않고 리터럴 `$` 로 되돌린다.
 */
export function splitMath(source: string): MathSegment[] {
  const segments: MathSegment[] = [];
  let text = '';
  let i = 0;

  const flushText = () => {
    if (text !== '') {
      segments.push({ kind: 'text', value: text });
      text = '';
    }
  };

  while (i < source.length) {
    const char = source[i];

    // 이스케이프 처리: `\$` -> `$`, `\\` -> `\\`(그대로)
    if (char === '\\' && source[i + 1] === '$') {
      text += '$';
      i += 2;
      continue;
    }

    const delimiter = DELIMITERS.find((candidate) => source.startsWith(candidate.open, i));
    if (!delimiter) {
      text += char;
      i += 1;
      continue;
    }

    const bodyStart = i + delimiter.open.length;
    const closeIndex = source.indexOf(delimiter.close, bodyStart);
    if (closeIndex === -1) {
      // 닫히지 않았다 -> 리터럴로 취급
      text += delimiter.open;
      i = bodyStart;
      continue;
    }

    const body = source.slice(bodyStart, closeIndex);
    if (!looksLikeMath(body)) {
      text += delimiter.open;
      i = bodyStart;
      continue;
    }

    flushText();
    segments.push({ kind: 'math', value: body, display: delimiter.display });
    i = closeIndex + delimiter.close.length;
  }

  flushText();
  return segments;
}

/** 수식이 하나도 없으면 false. (렌더 최적화/테스트용) */
export function hasMath(source: string): boolean {
  return splitMath(source).some((segment) => segment.kind === 'math');
}

/**
 * KaTeX HTML 문자열. 실패해도 예외를 던지지 않고 원문을 그대로 보여준다.
 * (풀이 전체가 흰 화면이 되는 것보다 낫다.)
 */
export function renderMathToHtml(value: string, display: boolean): string {
  try {
    return katex.renderToString(value, {
      displayMode: display,
      throwOnError: false,
      errorColor: '#b91c1c',
      strict: false,
      output: 'html',
      trust: false,
    });
  } catch {
    return escapeHtml(display ? `\\[${value}\\]` : `\\(${value}\\)`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 목록 미리보기용 한 줄 요약.
 * 마크다운 기호와 수식 구분자를 걷어내 원문 기호가 그대로 보이지 않게 한다.
 */
export function plainPreview(source: string): string {
  const firstLine = source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (!firstLine) return '';
  return firstLine
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\\\[|\\\]|\\\(|\\\)/g, '')
    .replace(/\$\$?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ── 텍스트 구간의 아주 얕은 마크다운 처리 ───────────────────────── */

export type InlineToken =
  | { kind: 'plain'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'code'; value: string };

const INLINE_RE = /\*\*([^*]+)\*\*|`([^`]+)`/g;

/**
 * `**굵게**` 와 `` `코드` `` 만 처리한다.
 * 전체 마크다운 파서를 넣지 않는 이유: 수식 위주 출력에서 오히려 오탐이 많다.
 */
export function splitInline(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;

  for (;;) {
    const match = INLINE_RE.exec(source);
    if (!match) break;
    if (match.index > last) {
      tokens.push({ kind: 'plain', value: source.slice(last, match.index) });
    }
    if (match[1] != null) tokens.push({ kind: 'bold', value: match[1] });
    else if (match[2] != null) tokens.push({ kind: 'code', value: match[2] });
    last = match.index + match[0].length;
  }

  if (last < source.length) {
    tokens.push({ kind: 'plain', value: source.slice(last) });
  }
  return tokens;
}
