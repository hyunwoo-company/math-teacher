/**
 * PDF 좌표계 변환.
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────
 * 백엔드 `extractor.py` 는 PyMuPDF 로 bbox 를 뽑는다. **PyMuPDF 좌표계는 원점이
 * 좌상단이고 y 가 아래로 증가한다.** 반면 pdf.js 의
 * `viewport.convertToViewportRectangle()` 은 **PDF 표준 좌표계(원점 좌하단,
 * y 가 위로 증가)** 를 기대한다. 그대로 넘기면 하이라이트가 세로로 뒤집힌다.
 *
 * ── 근거 데이터(extractor CLI 실제 출력) ─────────────────────────
 *    no page  bbox (x0,y0,x1,y1)
 *     1    1  32,69,290,142
 *     4    1  303,68,562,223
 * 1번과 4번은 시험지에서 둘 다 페이지 최상단이고 x 만 좌/우 칼럼으로 다르다
 * (32 vs 303). 그런데 y0 가 둘 다 68~69 로 작다 => 작은 y = 페이지 위쪽
 * => 좌상단 원점이 확정된다.
 * 이 값을 그대로 넘기면 4번이 841-223=618 ~ 841-68=773 으로 계산되어
 * 페이지 하단에 그려진다.
 */

/** MediaBox 의 y 범위. pdf.js `page.view` = `[x0, y0, x1, y1]` 에서 가져온다. */
export interface MediaBoxY {
  y0: number;
  y1: number;
}

export type Rect = [number, number, number, number];

/**
 * PyMuPDF(좌상단 원점) bbox -> PDF 표준(좌하단 원점) 사각형.
 *
 * 높이는 `y1 - y0` 로 계산한다. MediaBox 원점이 0 이 아닌 문서가 있기 때문에
 * `getViewport({scale:1}).height` 를 쓰면 안 된다(회전이 있으면 폭/높이가 뒤바뀐다).
 *
 * x 는 그대로 둔다. 두 좌표계 모두 x 는 왼쪽에서 오른쪽으로 증가하고,
 * MediaBox x 오프셋은 pdf.js 가 viewport 변환에서 이미 반영한다
 * (y 오프셋도 마찬가지이므로, 여기서는 "높이만큼 뒤집기" 만 한다).
 *
 * @param bbox `[x0, y0, x1, y1]` (PyMuPDF 좌표, pt)
 * @param media MediaBox 의 y 범위
 * @returns `convertToViewportRectangle()` 에 넣을 사각형
 */
export function toPdfSpaceRect(bbox: readonly number[], media: MediaBoxY): Rect {
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = bbox;
  const height = media.y1 - media.y0;
  return [x0, height - y1, x1, height - y0];
}

/** 화면 좌표 사각형(좌상단 기준 + 크기). */
export interface ViewportBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * `convertToViewportRectangle()` 결과를 CSS 배치용 박스로 정규화한다.
 * 변환 결과는 회전/뒤집힘에 따라 좌표 순서가 바뀔 수 있으므로 min/max 로 정리한다.
 */
export function normalizeViewportRect(rect: readonly number[], minSize = 2): ViewportBox {
  const [ax = 0, ay = 0, bx = 0, by = 0] = rect;
  const left = Math.min(ax, bx);
  const right = Math.max(ax, bx);
  const top = Math.min(ay, by);
  const bottom = Math.max(ay, by);
  return {
    left,
    top,
    width: Math.max(minSize, right - left),
    height: Math.max(minSize, bottom - top),
  };
}
