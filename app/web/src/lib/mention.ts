/**
 * 채팅 문장에서 "몇 번 문항을 말하는지" 를 추출한다.
 *
 * 문항 번호를 클릭하지 않고 "6번 문제에 이상한 점 없어?" 라고만 보내면
 * `problem_no` 가 null 로 가서 크롭 이미지가 첨부되지 않는다(계약상은 정상).
 * 사용자는 당연히 6번을 본다고 기대하므로 문장에서 번호를 찾아 채워 준다.
 *
 * **오탐이 나면 엉뚱한 문제 이미지를 붙여 답이 틀어지므로, 못 찾는 쪽이 낫다.**
 * 그래서 아래 규칙만 인정한다.
 *   - `6번`, `6 번`, `6번째`
 *   - `문제 6`, `문항 6` (붙여 써도 됨)
 *   - `#6`
 * 그리고 다음은 반드시 걸러낸다.
 *   - `3단계`, `2차`, `1학기`, `2026년`, `[3점]`, `x^2` 처럼 '번' 이 없는 수식/단위
 *   - 소수점·자리수 중간(`2.7` 의 7, `121` 의 21)
 *   - `2번째 줄` 처럼 '번째' 뒤에 다른 단위가 붙는 경우
 *   - 시험지에 없는 번호
 */

/**
 * 세 가지 형태를 한 번에 스캔한다.
 *  1) (문제|문항) + 숫자
 *  2) # + 숫자
 *  3) 숫자 + 번(째)
 */
const MENTION_RE = /(?:문제|문항)\s*(\d{1,3})|#\s*(\d{1,3})|(\d{1,3})\s*번(째)?/g;

/** 숫자 앞에 붙어 있으면 "번호" 가 아니라 더 큰 수/소수의 일부다. */
const NUMBER_CONTINUATION = /[\d.,]/;

/** `N번째` 뒤에 이런 단위가 오면 문항 번호가 아니다(줄 번호 등). */
const ORDINAL_UNIT_RE = /^\s*(줄|행|칸|단계|글자|문자|쪽|페이지|장|항)/;

/**
 * 문장에서 유효한 문항 번호를 등장 순서대로 모두 뽑는다(중복 제거).
 * 오탐 규칙은 위 주석과 동일하게 적용한다.
 *
 * @param text 사용자가 입력한 문장
 * @param availableNos 이 시험지에 실제로 있는 문항 번호들
 */
export function detectProblemNos(text: string, availableNos: readonly number[]): number[] {
  if (!text || availableNos.length === 0) return [];
  const allowed = new Set(availableNos);
  const found: number[] = [];
  const seen = new Set<number>();

  MENTION_RE.lastIndex = 0;
  for (;;) {
    const match = MENTION_RE.exec(text);
    if (!match) break;

    const [whole, byKeyword, byHash, byCounter, ordinalSuffix] = match;
    const digits = byKeyword ?? byHash ?? byCounter;
    if (digits == null) continue;

    // 숫자가 시작되는 위치를 찾아 앞 글자를 본다. (`2.7번` 의 7, `121번` 의 21 방지)
    const digitOffset = whole.indexOf(digits);
    const absoluteStart = match.index + (digitOffset === -1 ? 0 : digitOffset);
    const previousChar = absoluteStart > 0 ? text[absoluteStart - 1] : '';
    if (previousChar && NUMBER_CONTINUATION.test(previousChar)) continue;

    // `2번째 줄` 처럼 다른 것을 세는 표현은 제외한다.
    if (ordinalSuffix != null) {
      const rest = text.slice(match.index + whole.length);
      if (ORDINAL_UNIT_RE.test(rest)) continue;
    }

    const value = Number.parseInt(digits, 10);
    if (!Number.isInteger(value)) continue;
    // 시험지에 없는 번호는 버린다(추측하지 않는다).
    if (!allowed.has(value)) continue;
    if (seen.has(value)) continue;

    seen.add(value);
    found.push(value);
  }

  return found;
}

/**
 * 문장에서 문항 번호를 찾는다. 여러 개가 언급되면 첫 번째를 쓴다.
 *
 * @param text 사용자가 입력한 문장
 * @param availableNos 이 시험지에 실제로 있는 문항 번호들
 * @returns 문항 번호, 못 찾으면 null
 */
export function detectProblemNo(text: string, availableNos: readonly number[]): number | null {
  return detectProblemNos(text, availableNos)[0] ?? null;
}
