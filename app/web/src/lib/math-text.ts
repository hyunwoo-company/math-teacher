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
    .replace(/^#{1,6}\s*/, '')
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

/* ── 블록 레벨(제목/목록/문단) 파싱 ─────────────────────────────── */

export type Block =
  | { kind: 'heading'; level: number; content: string }
  | { kind: 'paragraph'; content: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  // 디스플레이 수식 패스스루. 여러 줄에 걸친 수식을 통째로 splitMath 로 넘긴다.
  | { kind: 'math'; content: string };

// 디스플레이 수식만 블록 경계를 무시해야 하므로 따로 추린다($$…$$, \[…\]).
const DISPLAY_DELIMITERS: readonly Delimiter[] = DELIMITERS.filter(
  (delimiter) => delimiter.display,
);

interface RawRegion {
  kind: 'text' | 'math';
  value: string;
}

/**
 * 디스플레이 수식 구간을 먼저 떼어낸다.
 * 이 구간은 줄 단위 블록 파싱에서 제외해, 수식 내부 개행이 제목/목록/문단
 * 경계로 오인되는 것을 막는다. 닫는 구분자를 못 찾으면 리터럴 텍스트로 둔다.
 */
function scanDisplayMath(source: string): RawRegion[] {
  const regions: RawRegion[] = [];
  let text = '';
  let i = 0;

  const flush = () => {
    if (text !== '') {
      regions.push({ kind: 'text', value: text });
      text = '';
    }
  };

  while (i < source.length) {
    const char = source[i];

    // 이스케이프(`\$`, `\\`)는 두 글자를 그대로 보존해 구분자 오탐을 막는다.
    if (char === '\\' && (source[i + 1] === '$' || source[i + 1] === '\\')) {
      text += char + source[i + 1];
      i += 2;
      continue;
    }

    const delimiter = DISPLAY_DELIMITERS.find((candidate) =>
      source.startsWith(candidate.open, i),
    );
    if (delimiter) {
      const bodyStart = i + delimiter.open.length;
      const closeIndex = source.indexOf(delimiter.close, bodyStart);
      if (closeIndex !== -1 && looksLikeMath(source.slice(bodyStart, closeIndex))) {
        flush();
        const end = closeIndex + delimiter.close.length;
        regions.push({ kind: 'math', value: source.slice(i, end) });
        i = end;
        continue;
      }
    }

    text += char;
    i += 1;
  }

  flush();
  return regions;
}

// 최대 3칸 들여쓰기까지는 마크다운으로 인정한다.
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*$/;
const UL_RE = /^ {0,3}[-*]\s+(.+?)\s*$/;
const OL_RE = /^ {0,3}\d+\.\s+(.+?)\s*$/;

type ListBlock = Extract<Block, { kind: 'ul' | 'ol' }>;

/** 디스플레이 수식이 제거된 텍스트 구간을 줄 단위로 블록으로 분류한다. */
function parseTextRegion(text: string, blocks: Block[]): void {
  let paragraph: string[] = [];
  let list: ListBlock | null = null;

  const flushParagraph = () => {
    const content = paragraph.join('\n');
    if (content.trim() !== '') blocks.push({ kind: 'paragraph', content });
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      blocks.push(list);
      list = null;
    }
  };

  for (const line of text.split('\n')) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', level: heading[1]!.length, content: heading[2]! });
      continue;
    }

    const ul = UL_RE.exec(line);
    if (ul) {
      flushParagraph();
      if (list?.kind === 'ul') list.items.push(ul[1]!);
      else {
        flushList();
        list = { kind: 'ul', items: [ul[1]!] };
      }
      continue;
    }

    const ol = OL_RE.exec(line);
    if (ol) {
      flushParagraph();
      if (list?.kind === 'ol') list.items.push(ol[1]!);
      else {
        flushList();
        list = { kind: 'ol', items: [ol[1]!] };
      }
      continue;
    }

    // 문단 줄 또는 빈 줄
    flushList();
    if (line.trim() === '') flushParagraph();
    else paragraph.push(line);
  }

  flushParagraph();
  flushList();
}

/**
 * 원문을 블록(제목/목록/문단/디스플레이 수식)으로 나눈다.
 * 각 블록의 텍스트는 이후 `splitMath` + 인라인 처리를 그대로 통과한다.
 */
export function parseBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  for (const region of scanDisplayMath(source)) {
    if (region.kind === 'math') blocks.push({ kind: 'math', content: region.value });
    else parseTextRegion(region.value, blocks);
  }
  return blocks;
}

/* ── 검산 언급 제거(표시 전용) ──────────────────────────────────── */

// 수식 자리표시자. 사설 영역(PUA) 문자라 본문에 나올 일이 없다.
const MASK_OPEN = '\uE000';
const MASK_CLOSE = '\uE001';
const MASK_RE = new RegExp(`${MASK_OPEN}(\\d+)${MASK_CLOSE}`, 'g');

/**
 * 수식 구간을 **원문 그대로** 보관하고 자리표시자로 바꾼다.
 *
 * 줄 단위로 문장을 지우기 전에 수식을 치워 두는 목적이다. 여러 줄 디스플레이
 * 수식도 한 자리표시자가 되므로 줄 구조가 흐트러지지 않고, 되돌릴 때 구분자
 * 종류(`$$` / `\[`)까지 원문대로 복원된다.
 */
function maskMath(source: string): { masked: string; regions: string[] } {
  const regions: string[] = [];
  let masked = '';
  let i = 0;

  while (i < source.length) {
    const char = source[i];
    // 이스케이프(`\$`, `\\`)는 두 글자를 그대로 넘겨 구분자 오탐을 막는다.
    if (char === '\\' && (source[i + 1] === '$' || source[i + 1] === '\\')) {
      masked += char + source[i + 1];
      i += 2;
      continue;
    }

    const delimiter = DELIMITERS.find((candidate) => source.startsWith(candidate.open, i));
    if (delimiter) {
      const bodyStart = i + delimiter.open.length;
      const closeIndex = source.indexOf(delimiter.close, bodyStart);
      if (closeIndex !== -1 && looksLikeMath(source.slice(bodyStart, closeIndex))) {
        const end = closeIndex + delimiter.close.length;
        masked += `${MASK_OPEN}${regions.length}${MASK_CLOSE}`;
        regions.push(source.slice(i, end));
        i = end;
        continue;
      }
    }

    masked += char;
    i += 1;
  }

  return { masked, regions };
}

function unmaskMath(masked: string, regions: readonly string[]): string {
  return masked.replace(MASK_RE, (whole: string, index: string) => regions[Number(index)] ?? whole);
}

/** 검산을 "이미 했다 / 생략했다" 고 밝히는 표시. 이게 없으면 문제 지시문일 수 있어 남긴다. */
const VERIFY_DONE = '(?:했|하였|마쳤|마치|끝냈|완료|생략|정상|이상\\s*없|성립|일치|맞|같|✔|✓)';
/** 문장 맨 앞에 붙을 수 있는 접속어. */
const LEAD_WORDS = '(?:따라서|그러므로|또한|그리고|또|끝으로|마지막으로|참고로|추가로)?';

/** ① `검산:` 라벨로 시작하거나, 검산으로 시작해 완료 표시가 곧 따라오는 문장. */
const VERIFY_LEAD_RE = new RegExp(
  `^[\\s,·]*${LEAD_WORDS}[\\s,·]*검산(?:\\s*[:：)\\-–—]|[^.!?]{0,20}${VERIFY_DONE})`,
);
/** ② `검산` 딱 한 단어(뒤에 ✔ 만 붙은 것 포함). */
const VERIFY_LABEL_RE = /^[\s,·]*검산[\s✔✓]*$/;
/** ③ 짧은 도입부 뒤에 검산 완료 언급만 있는 문장. 앞말이 10자를 넘으면 실제 내용으로 본다. */
const VERIFY_MENTION_RE =
  /^[^.!?]{0,10}검산(?:을|도|까지|은|는|이|만)?\s*(?:했|하였|마쳤|마치|끝냈|완료|생략)/;
/** ④ 체크 표시만 남은 줄. */
const CHECK_ONLY_RE = /^[\s✔✓]+$/;
/** 제목은 라벨이라 `검산` 으로 시작하면 그 섹션 전체를 검산 섹션으로 본다. */
const VERIFY_HEADING_RE = /^검산/;
/** 이 줄이 제목인지(그리고 몇 단계인지). `parseBlocks` 의 제목 규칙과 같게 맞춘다. */
const STRIP_HEADING_RE = /^ {0,3}(#{1,6})\s+(.+?)\s*$/;

/** 줄 앞뒤의 마크다운 장식(제목/목록/인용/굵게)을 걷어낸 판정용 내용. */
function lineContent(line: string): string {
  return line
    .replace(/^\s*#{1,6}\s*/, '')
    .replace(/^\s*>+\s*/, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\s*\*\*/, '')
    .replace(/\*\*\s*$/, '')
    .trim();
}

/** 종결부호(`.!?`)와 뒤따르는 공백을 각 조각에 붙여 자른다(이어 붙이면 원문 복원). */
function splitSentences(line: string): string[] {
  return line.match(/[^.!?]+[.!?]*\s*|[.!?]+\s*/g) ?? [line];
}

/** 이 문장이 "검산을 했다/생략했다" 는 언급뿐인지. */
function mentionsVerificationOnly(text: string): boolean {
  return VERIFY_LABEL_RE.test(text) || VERIFY_LEAD_RE.test(text) || VERIFY_MENTION_RE.test(text);
}

/**
 * 한 줄에서 검산 언급을 걷어낸다.
 * @returns 남길 줄. 줄 자체를 지워야 하면 null.
 */
function stripVerificationLine(line: string, isHeading: boolean): string | null {
  const content = lineContent(line);
  if (content === '') return line;
  if (CHECK_ONLY_RE.test(content)) return null;
  // 제목은 구조다. 검산 섹션 규칙(아래 stripVerification)에서만 지운다.
  if (isHeading) return line;

  const sentences = splitSentences(line);
  const kept: string[] = [];
  let removed = false;
  sentences.forEach((sentence, index) => {
    // 목록 기호·굵게는 줄 맨 앞에만 붙으므로 첫 문장에서만 걷어내고 판정한다.
    const text = index === 0 ? lineContent(sentence) : sentence.trim();
    if (text !== '' && mentionsVerificationOnly(text)) {
      removed = true;
      return;
    }
    kept.push(sentence);
  });
  if (!removed) return line;

  // 검산 문장을 지운 줄에서 홀로 남은 ✔ 는 흔적이므로 함께 걷어낸다.
  const rest = kept.join('').replace(/[\s✔✓]+$/, '');
  return lineContent(rest) === '' ? null : rest;
}

/**
 * 표시 직전에 "검산" 언급만 남은 문장·줄·섹션을 걷어낸다.
 *
 * 배경: 프롬프트에서 검산 과정 출력을 막았지만 모델이 "검산했습니다" 같은 언급만
 * 남기는 경우가 있고, **이미 저장된 옛 풀이는 그대로 남아 있다.** 그래서 표시
 * 단계에서 지운다. 원문(스토어의 `text`)은 건드리지 않는다 —
 * "복사(AI 대화용)" 는 마크다운 원문을 그대로 줘야 한다.
 *
 * 보수적으로 지운다. 검산이 의미 있게 쓰인 문장("검산하시오", "검산의 정의")은
 * 남기고, 검산을 이미 했다/생략했다고 밝히는 문장만 지운다. 경계는
 * `math-text.test.ts` 의 "지운다 / 지우지 않는다" 두 묶음이 명시한다.
 *
 * @param source AI 응답 원문(마크다운 + LaTeX).
 * @returns 검산 언급을 걷어낸 텍스트. 지울 것이 없으면 원문 그대로.
 */
export function stripVerification(source: string): string {
  const { masked, regions } = maskMath(source);
  const kept: string[] = [];
  // 검산 섹션 안이면 그 제목의 단계(#의 개수). 같은 단계 이상 제목을 만나면 끝난다.
  let skipUntilLevel: number | null = null;
  let changed = false;

  for (const line of masked.split('\n')) {
    const heading = STRIP_HEADING_RE.exec(line);
    const level = heading ? (heading[1] ?? '').length : 0;

    if (skipUntilLevel != null) {
      if (heading && level <= skipUntilLevel) skipUntilLevel = null;
      else {
        changed = true;
        continue;
      }
    }

    if (heading && VERIFY_HEADING_RE.test(lineContent(heading[2] ?? ''))) {
      skipUntilLevel = level;
      changed = true;
      continue;
    }

    const next = stripVerificationLine(line, heading != null);
    if (next == null) {
      changed = true;
      continue;
    }
    if (next !== line) changed = true;
    kept.push(next);
  }

  if (!changed) return source;
  // 지운 자리에 빈 줄이 겹치는 것만 정리한다(블록 파싱 결과는 달라지지 않는다).
  const result = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  return unmaskMath(result, regions);
}
