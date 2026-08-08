/**
 * 마크다운 + LaTeX 원문을 "한글/워드에 붙여도 읽히는" 유니코드 평문으로 바꾼다.
 *
 * 목적: 기존 복사(마크다운 원문)는 `\(x^2\)` 같은 LaTeX 가 그대로 붙어 한글·워드에서
 * 깨진다. 이 변환기는 수식 구분자를 없애고 LaTeX 명령을 유니코드 기호/첨자로 바꿔
 * 사람이 읽을 수 있게 만든다. 매핑에 없는 명령은 백슬래시/중괄호만 걷어내
 * (깨진 `\(...\)` 를 남기지 않고) 최대한 읽히게 한다.
 *
 * KaTeX 렌더와 무관한 순수 문자열 변환이라 서버/클라이언트 어디서든 쓸 수 있다.
 */

import { splitMath } from '@/lib/math-text';

/* ── 유니코드 위/아래 첨자 ──────────────────────────────────────── */

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ',
  i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ',
  r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ',
};

const SUBSCRIPT: Readonly<Record<string, string>> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ',
  n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ',
};

/**
 * 문자열 전체가 첨자로 변환 가능하면 유니코드 첨자로, 하나라도 불가능하면
 * `^(...)` / `_(...)` 로 폴백한다(깨지지 않게).
 */
function toScript(value: string, sup: boolean): string {
  if (value === '') return sup ? '^' : '_';
  const map = sup ? SUPERSCRIPT : SUBSCRIPT;
  let mapped = '';
  for (const ch of value) {
    const next = map[ch];
    if (next === undefined) return sup ? `^(${value})` : `_(${value})`;
    mapped += next;
  }
  return mapped;
}

/* ── LaTeX 명령 매핑 ────────────────────────────────────────────── */

// 인자 없는 기호(그리스 문자, 연산자, 관계, 화살표, 집합/논리 등).
const SYMBOLS: Readonly<Record<string, string>> = {
  // 그리스 소문자
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  // 그리스 대문자
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // 연산자
  times: '×', div: '÷', pm: '±', mp: '∓', cdot: '·', ast: '∗', star: '⋆',
  circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
  // 관계
  le: '≤', leq: '≤', ge: '≥', geq: '≥', neq: '≠', ne: '≠', equiv: '≡',
  approx: '≈', cong: '≅', sim: '∼', simeq: '≃', propto: '∝', ll: '≪',
  gg: '≫', doteq: '≐',
  // 화살표
  to: '→', rightarrow: '→', Rightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑',
  downarrow: '↓', implies: '⇒', iff: '⇔',
  // 집합/논리
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', varnothing: '∅',
  setminus: '∖', forall: '∀', exists: '∃', nexists: '∄', neg: '¬',
  land: '∧', lor: '∨', wedge: '∧', vee: '∨',
  // 기타
  infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏', int: '∫',
  oint: '∮', angle: '∠', measuredangle: '∡', perp: '⊥', parallel: '∥',
  nparallel: '∦', cdots: '⋯', ldots: '…', dots: '…', vdots: '⋮', ddots: '⋱',
  prime: '′', degree: '°', deg: '°', therefore: '∴', because: '∵',
  hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩',
  vert: '|', lvert: '|', rvert: '|', Vert: '‖', mid: '|',
  // 공백 명령
  quad: ' ', qquad: ' ',
};

// 인자 1개를 받아 서식만 벗기고 내용은 그대로 통과시키는 명령.
const ONE_ARG_PASS: ReadonlySet<string> = new Set([
  'mathbf', 'mathrm', 'mathit', 'mathcal', 'mathbb', 'mathsf', 'mathtt',
  'boldsymbol', 'bm', 'vec', 'hat', 'bar', 'overline', 'underline', 'tilde',
  'dot', 'ddot', 'overrightarrow', 'overleftarrow', 'widehat', 'widetilde',
]);

// 인자를 "리터럴 텍스트"로 그대로 내보내는 명령(수식 변환하지 않음).
const TEXT_ARG: ReadonlySet<string> = new Set([
  'text', 'textrm', 'textbf', 'textit', 'textsf', 'texttt', 'mbox',
  'operatorname',
]);

// 서식 전용이라 통째로 버리는 명령.
const DROP: ReadonlySet<string> = new Set([
  'displaystyle', 'textstyle', 'scriptstyle', 'scriptscriptstyle',
  'limits', 'nolimits',
]);

/* ── LaTeX 본문 파서 ────────────────────────────────────────────── */

/** `{...}` 균형 그룹을 읽는다. i 는 여는 중괄호 위치. */
function readBraced(s: string, i: number): { content: string; end: number } {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    if (s[j] === '{') depth += 1;
    else if (s[j] === '}') {
      depth -= 1;
      if (depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
    }
  }
  return { content: s.slice(i + 1), end: s.length };
}

/** 첨자/명령의 인자 하나를 읽는다: `{...}`, `\cmd`, 또는 한 글자. */
function readArg(s: string, i: number): { raw: string; end: number } {
  let k = i;
  while (k < s.length && s[k] === ' ') k += 1;
  if (k >= s.length) return { raw: '', end: k };
  if (s[k] === '{') {
    const g = readBraced(s, k);
    return { raw: g.content, end: g.end };
  }
  if (s[k] === '\\') {
    let j = k + 1;
    if (j < s.length && /[a-zA-Z]/.test(s[j]!)) {
      while (j < s.length && /[a-zA-Z]/.test(s[j]!)) j += 1;
    } else {
      j += 1;
    }
    return { raw: s.slice(k, j), end: j };
  }
  return { raw: s[k]!, end: k + 1 };
}

const NON_LETTER_ESCAPE: Readonly<Record<string, string>> = {
  '{': '{', '}': '}', '%': '%', '#': '#', '&': '&', _: '_', $: '$',
};

/** `\` 로 시작하는 명령을 해석해 치환 문자열과 다음 인덱스를 돌려준다. */
function readCommand(s: string, i: number): { text: string; end: number } {
  const next = s[i + 1];
  if (next === undefined) return { text: '', end: i + 1 };

  if (!/[a-zA-Z]/.test(next)) {
    if (next in NON_LETTER_ESCAPE) return { text: NON_LETTER_ESCAPE[next]!, end: i + 2 };
    // `\,` `\;` `\:` `\ ` `\\`(줄바꿈) 는 공백, `\!`(음수 공백)은 제거.
    if (next === '!') return { text: '', end: i + 2 };
    if (next === ',' || next === ';' || next === ':' || next === ' ' || next === '\\') {
      return { text: ' ', end: i + 2 };
    }
    return { text: next, end: i + 2 };
  }

  let j = i + 1;
  while (j < s.length && /[a-zA-Z]/.test(s[j]!)) j += 1;
  const name = s.slice(i + 1, j);

  if (name === 'frac' || name === 'dfrac' || name === 'tfrac' || name === 'cfrac') {
    const a = readArg(s, j);
    const b = readArg(s, a.end);
    return { text: `(${convert(a.raw)})/(${convert(b.raw)})`, end: b.end };
  }
  if (name === 'sqrt') {
    let k = j;
    while (k < s.length && s[k] === ' ') k += 1;
    let index = '';
    if (s[k] === '[') {
      const close = s.indexOf(']', k);
      if (close !== -1) {
        index = s.slice(k + 1, close);
        k = close + 1;
      }
    }
    const a = readArg(s, k);
    const root = index === '' ? '' : toScript(convert(index), true);
    return { text: `${root}√(${convert(a.raw)})`, end: a.end };
  }
  if (TEXT_ARG.has(name)) {
    const a = readArg(s, j);
    return { text: a.raw, end: a.end };
  }
  if (ONE_ARG_PASS.has(name)) {
    const a = readArg(s, j);
    return { text: convert(a.raw), end: a.end };
  }
  if (name === 'begin' || name === 'end') {
    const a = readArg(s, j);
    return { text: '', end: a.end };
  }
  if (name === 'left' || name === 'right') {
    // 뒤따르는 구분자 문자는 그대로 살린다. `\left.`/`\right.` 의 점은 버린다.
    let k = j;
    while (k < s.length && s[k] === ' ') k += 1;
    if (s[k] === '.') return { text: '', end: k + 1 };
    return { text: '', end: j };
  }
  const symbol = SYMBOLS[name];
  if (symbol !== undefined) return { text: symbol, end: j };
  if (DROP.has(name)) return { text: '', end: j };

  // 매핑에 없는 명령: 백슬래시만 떼고 이름을 남겨 읽히게 둔다(예: \sin -> sin).
  return { text: name, end: j };
}

/** LaTeX 본문을 유니코드 평문으로 바꾼다(재귀). */
function convert(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      const r = readCommand(s, i);
      out += r.text;
      i = r.end;
      continue;
    }
    if (c === '^') {
      const a = readArg(s, i + 1);
      out += toScript(convert(a.raw), true);
      i = a.end;
      continue;
    }
    if (c === '_') {
      const a = readArg(s, i + 1);
      out += toScript(convert(a.raw), false);
      i = a.end;
      continue;
    }
    if (c === '{') {
      const g = readBraced(s, i);
      out += convert(g.content);
      i = g.end;
      continue;
    }
    if (c === '}') {
      i += 1;
      continue;
    }
    if (c === '&' || c === '~') {
      out += ' ';
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 수식 본문(구분자는 이미 제거됨)을 한 줄 유니코드로 변환한다. */
function convertMath(body: string): string {
  return convert(body).replace(/\s+/g, ' ').trim();
}

/* ── 마크다운 평문화 ────────────────────────────────────────────── */

function stripMarkdown(text: string): string {
  const lines = text.split('\n').map((line) => {
    let s = line;
    s = s.replace(/^\s{0,3}#{1,6}\s+/, ''); // 제목 -> 줄
    s = s.replace(/^(\s{0,3})[-*+]\s+/, '$1• '); // 순서 없는 목록 -> •
    return s;
  });
  let out = lines.join('\n');
  // 수식이 유니코드로 바뀐 뒤라 굵게/코드 마커가 다시 인접해 있다.
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  out = out.replace(/\*\*/g, '');
  out = out.replace(/`([^`]+)`/g, '$1');
  out = out.replace(/`/g, '');
  // 파싱되지 못한 LaTeX 구분자 잔재 제거(깨진 \( \) \[ \] 방지).
  out = out.replace(/\\[()[\]]/g, '');
  // 공백 정리
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/[ \t]+$/gm, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/**
 * 마크다운 + LaTeX 원문을 유니코드 평문으로 변환한다.
 * 수식은 유니코드 기호/첨자로, 마크다운 기호는 평문으로 바꾼다.
 */
export function toPlainText(source: string): string {
  const assembled = splitMath(source)
    .map((segment) => (segment.kind === 'math' ? convertMath(segment.value) : segment.value))
    .join('');
  return stripMarkdown(assembled);
}
