/**
 * 문항 번호의 **표시** 규칙.
 *
 * 문항에는 번호가 둘이다.
 * - `no`  — 문서 안에서 유일한 통짜 순번. 저장·조회·선택·API 경로는 **전부 이 값**이다.
 * - `label` — 지면에 실제로 찍힌 표기. 정석 계열(`기본 문제 1-1` / `유제 1-1`)처럼
 *   구획마다 번호가 되돌아가는 교재에서만 `no` 와 다르다.
 *
 * 여기 있는 함수는 **화면에 무엇을 보여줄지**만 정한다. 값을 바꾸지 않는다 —
 * 클릭·선택·키보드 조작이 넘기는 값은 여전히 `no` 다.
 *
 * 백엔드의 같은 규칙은 `app/core/export/build.py` 의 `_display_no` 다.
 */

/**
 * 지면 표기가 `no` 와 다를 때만 그 표기를 돌려준다.
 *
 * @param no 문항 번호(통짜 순번).
 * @param label 지면 표기. 없거나 공백뿐이면 없는 것으로 본다.
 * @returns 보여줄 표기, 또는 보여줄 것이 없으면 `null`(보통 시험지).
 */
export function printedLabel(no: number, label?: string | null): string | null {
  const printed = (label ?? '').trim();
  if (printed === '' || printed === String(no)) return null;
  return printed;
}

/**
 * 문항 번호 칩 안에 보일 글자.
 *
 * 칩은 좁으므로 `번` 을 붙이지 않는다(지금도 숫자만 찍는다).
 *
 * @param no 문항 번호.
 * @param label 지면 표기.
 * @returns 표기가 다르면 그 표기, 아니면 번호 문자열.
 */
export function problemChipText(no: number, label?: string | null): string {
  return printedLabel(no, label) ?? String(no);
}

/**
 * 접근성 이름·툴팁 뒤에 덧붙일 표기 꼬리.
 *
 * 표기가 없으면 **빈 문자열**이라 기존 문구가 한 글자도 달라지지 않는다.
 * 꼬리를 붙이는 쪽을 고른 이유: 접근성 이름의 앞머리는 `{no}번` 으로 남겨야
 * 화면의 선택 상태(= `no`)와 읽히는 이름이 어긋나지 않는다.
 *
 * @param no 문항 번호.
 * @param label 지면 표기.
 * @returns ` (문제지 표기 기본 문제 1-1)` 같은 꼬리, 또는 빈 문자열.
 */
export function printedLabelSuffix(no: number, label?: string | null): string {
  const printed = printedLabel(no, label);
  return printed === null ? '' : ` (문제지 표기 ${printed})`;
}
