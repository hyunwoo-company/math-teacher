/**
 * 트리 끌기 한 번의 "수명" 판정(순수 함수).
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 * HTML5 네이티브 끌기는 끝맺음이 한 가지가 아니다. 폴더에 떨구기, 받아 줄
 * 대상이 없는 곳에서 놓기, Esc 로 취소, 창 밖으로 끌고 나가기… 브라우저마다
 * 어떤 이벤트가 오는지도 조금씩 다르다. 그래서 "끌기가 끝났다" 를 한 곳에서
 * 값으로 정리하고, 그 값만 여기서 계산한다.
 *
 * 특히 **끌기 직후에 따라오는 click**: 끌기를 하려던 것인데 click 으로 처리되어
 * 파일이 열려 버리면 사용자는 "드래그가 안 된다" 고 느낀다. 끌기가 끝난 직후
 * 아주 짧은 시간 안에 오는 click 한 번은 무시한다.
 *
 * DOM 을 만지지 않으므로 규칙은 이 파일에서만 단위 테스트로 굳힌다.
 */

/** 끌기가 끝난 뒤 이 시간(ms) 안에 오는 click 한 번은 끌기의 잔상으로 보고 무시한다. */
export const CLICK_SUPPRESS_MS = 250;

/**
 * 끌기 잔상 click 을 막기 위한 표식.
 *
 * `at` 은 마지막으로 끌기 상태가 바뀐 시각(ms). 시각을 들고 있기 때문에
 * `dragend` 가 영영 오지 않는 브라우저에서도 표식이 영구히 남아 멀쩡한 click 을
 * 잡아먹는 일이 없다(시간이 지나면 저절로 풀린다).
 */
export interface ClickGuard {
  at: number | null;
}

/** 아무 끌기도 없었던 초기 상태. */
export const NO_CLICK_GUARD: ClickGuard = { at: null };

/**
 * 끌기 시작/끝 시각을 찍는다.
 *
 * @param now 지금 시각(ms). `Date.now()`.
 */
export function armClickGuard(now: number): ClickGuard {
  return { at: now };
}

/**
 * 이 click 이 방금 끝난 끌기의 잔상인지.
 *
 * @param guard 마지막으로 찍은 표식.
 * @param now click 이 온 시각(ms).
 * @param window 잔상으로 볼 시간 폭. 기본 {@link CLICK_SUPPRESS_MS}.
 * @returns 무시해야 하면 true.
 */
export function shouldSuppressClick(
  guard: ClickGuard,
  now: number,
  window: number = CLICK_SUPPRESS_MS,
): boolean {
  if (guard.at == null) return false;
  const elapsed = now - guard.at;
  // 시계가 뒤로 갔거나(음수) 시간이 지났으면 잔상이 아니다.
  return elapsed >= 0 && elapsed <= window;
}

/**
 * 이 키 입력이 "끌기·선택을 취소" 인지.
 *
 * 이미 다른 곳(검색어 지우기·대화상자 닫기)에서 처리한 Esc 는 건드리지 않는다.
 * 그쪽이 `preventDefault()` 를 하므로 그것으로 가려낸다.
 *
 * @param event `key` 와 `defaultPrevented` 만 본다.
 */
export function isDragCancelKey(event: { key: string; defaultPrevented: boolean }): boolean {
  return event.key === 'Escape' && !event.defaultPrevented;
}

/**
 * 빈 공간에서 누른 것이 "그냥 클릭" 이었는지(= 고무줄이 되지 못했는지).
 *
 * 그냥 클릭이면 선택과 끌기 상태를 지운다 — 파일 탐색기에서 빈 곳을 클릭하면
 * 선택이 풀리는 것과 같다. 단 Ctrl/Cmd 를 누른 채였다면 사용자가 선택을
 * 쌓는 중이므로 지우지 않는다.
 *
 * @param session 진행 중이던 고무줄 세션. 없으면 false.
 */
export function isBlankClick(session: { moved: boolean; additive: boolean } | null): boolean {
  return session != null && !session.moved && !session.additive;
}
