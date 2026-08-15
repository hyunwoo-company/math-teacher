/**
 * 드래그 중 자동 스크롤 속도 계산(순수 함수).
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 * HTML5 네이티브 드래그는 브라우저가 스크롤을 대신 해 주지 않는다(자체 스크롤
 * 컨테이너 안에서는 특히). 그래서 화면 밖에 있는 폴더로 항목을 옮기려 해도
 * 목록이 따라 올라오지 않아 아예 도달할 수가 없다.
 *
 * 실제 스크롤은 `requestAnimationFrame` 루프가 하고, 여기서는 "지금 포인터
 * 위치면 한 프레임에 몇 px 움직여야 하나" 만 정한다. DOM 을 만지지 않으므로
 * 규칙은 이 파일에서만 단위 테스트로 굳힌다.
 */

/** 가장자리에서 이 거리(px) 안에 들어오면 자동 스크롤이 걸린다. */
export const AUTO_SCROLL_EDGE_PX = 48;

/** 한 프레임에 움직이는 최대 거리(px). 60fps 기준 약 840px/s. */
export const AUTO_SCROLL_MAX_SPEED_PX = 14;

export interface AutoScrollInput {
  /** 포인터의 화면 y 좌표(`DragEvent.clientY`). */
  pointerY: number;
  /** 스크롤 컨테이너 위쪽 화면 y (`getBoundingClientRect().top`). */
  top: number;
  /** 스크롤 컨테이너 아래쪽 화면 y (`getBoundingClientRect().bottom`). */
  bottom: number;
  /** 가장자리 판정 거리. 기본 {@link AUTO_SCROLL_EDGE_PX}. */
  threshold?: number;
  /** 프레임당 최대 이동량. 기본 {@link AUTO_SCROLL_MAX_SPEED_PX}. */
  maxSpeed?: number;
}

/**
 * 드래그 중 자동 스크롤 속도(px/frame)를 구한다.
 *
 * - 음수면 위로, 양수면 아래로, 0이면 멈춘다.
 * - 가장자리에 가까울수록 빨라진다(선형 보간). 딱 가장자리에서 `maxSpeed`,
 *   임계값 거리에서 0.
 * - 컨테이너 **밖**은 0이다. 커서가 패널을 벗어났는데도 계속 굴러가면
 *   사용자가 멈출 방법이 없다.
 * - 컨테이너가 임계값의 2배보다 낮으면 임계값을 높이의 절반으로 줄인다.
 *   그러지 않으면 위/아래 구역이 겹쳐, 한가운데인데도 한쪽으로 끌려간다.
 *
 * @param input 포인터 y 와 컨테이너 상/하단(화면 좌표), 선택적 임계값·최대 속도.
 * @returns 한 프레임에 더할 `scrollTop` 변화량.
 */
export function autoScrollSpeed(input: AutoScrollInput): number {
  const {
    pointerY,
    top,
    bottom,
    threshold = AUTO_SCROLL_EDGE_PX,
    maxSpeed = AUTO_SCROLL_MAX_SPEED_PX,
  } = input;

  const height = bottom - top;
  if (height <= 0 || threshold <= 0 || maxSpeed <= 0) return 0;
  if (pointerY < top || pointerY > bottom) return 0;

  // 위/아래 구역이 절대 겹치지 않도록 높이의 절반으로 자른다.
  const edge = Math.min(threshold, height / 2);

  const fromTop = pointerY - top;
  if (fromTop < edge) return -maxSpeed * (1 - fromTop / edge);

  const fromBottom = bottom - pointerY;
  if (fromBottom < edge) return maxSpeed * (1 - fromBottom / edge);

  return 0;
}
