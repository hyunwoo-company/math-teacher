/**
 * 트리 다중 선택 계산(순수 함수).
 *
 * 클릭 한 번이 선택을 어떻게 바꾸는지는 파일 탐색기 관례를 따른다.
 * DOM 이벤트가 아니라 값만 다루므로 여기만 단위 테스트로 굳힌다.
 */

import type { TreeItem } from '@/lib/tree';

/** Ctrl/Cmd·Shift 조합. 클릭 이벤트에서 뽑아 넘긴다. */
export interface SelectionModifiers {
  /** Ctrl(Windows)/Cmd(mac): 그 행만 켜고 끈다. */
  toggle: boolean;
  /** Shift: 기준점(anchor)부터 클릭한 행까지 범위 선택. */
  range: boolean;
}

export interface SelectionInput {
  /** 지금 선택된 id 들. */
  current: ReadonlySet<string>;
  /** 범위 선택의 기준점. 아직 없으면 null. */
  anchorId: string | null;
  /** 방금 클릭한 행. */
  clickedId: string;
  modifiers: SelectionModifiers;
  /** 화면에 보이는 순서대로 평탄화한 id 목록(범위 계산 기준). */
  visibleIds: readonly string[];
}

export interface SelectionResult {
  selected: Set<string>;
  /** 다음 범위 선택이 쓸 기준점. */
  anchorId: string;
}

/**
 * 화면에 실제로 보이는 행들의 id 를 위에서 아래 순서로 평탄화한다.
 *
 * 접힌 폴더의 자식은 그리지 않으므로 범위 선택에서도 제외해야 한다
 * (안 그러면 보이지도 않는 노드가 함께 끌려간다).
 *
 * @param roots `buildTree` 결과.
 * @param expanded 펼침 상태 맵.
 * @returns 보이는 순서대로의 노드 id 배열.
 */
export function visibleNodeIds(
  roots: readonly TreeItem[],
  expanded: Readonly<Record<string, boolean>>,
): string[] {
  const ids: string[] = [];
  const walk = (items: readonly TreeItem[]): void => {
    for (const item of items) {
      ids.push(item.node.id);
      const isOpenFolder = item.node.type === 'folder' && expanded[item.node.id] === true;
      if (isOpenFolder) walk(item.children);
    }
  };
  walk(roots);
  return ids;
}

/**
 * 클릭 한 번 뒤의 선택 상태를 계산한다.
 *
 * - 그냥 클릭: 클릭한 행 하나만 선택.
 * - Ctrl/Cmd 클릭: 그 행을 토글(다른 선택은 유지).
 * - Shift 클릭: 기준점부터 클릭한 행까지 범위로 교체.
 * - Ctrl+Shift 클릭: 기존 선택에 그 범위를 더한다.
 *
 * 기준점이 없거나 화면에서 사라졌으면 범위 선택은 단일 선택으로 떨어진다.
 *
 * @param input 현재 선택·기준점·클릭한 행·수정키·보이는 순서.
 * @returns 새 선택 집합과 다음 기준점.
 */
export function nextSelection(input: SelectionInput): SelectionResult {
  const { current, anchorId, clickedId, modifiers, visibleIds } = input;

  if (modifiers.range && anchorId != null) {
    const from = visibleIds.indexOf(anchorId);
    const to = visibleIds.indexOf(clickedId);
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      const range = visibleIds.slice(start, end + 1);
      const selected = modifiers.toggle ? new Set(current) : new Set<string>();
      for (const id of range) selected.add(id);
      // 기준점은 유지한다. 그래야 Shift 를 누른 채 범위를 늘였다 줄였다 할 수 있다.
      return { selected, anchorId };
    }
  }

  if (modifiers.toggle) {
    const selected = new Set(current);
    if (selected.has(clickedId)) selected.delete(clickedId);
    else selected.add(clickedId);
    return { selected, anchorId: clickedId };
  }

  return { selected: new Set([clickedId]), anchorId: clickedId };
}

/**
 * 드래그로 옮길 대상 id 들을 정한다.
 *
 * 끌기 시작한 행이 선택에 들어 있으면 선택 전체를, 아니면 그 행 하나만 옮긴다
 * (파일 탐색기와 같은 규칙).
 *
 * @param selected 현재 선택.
 * @param draggedId 끌기 시작한 행.
 * @param visibleIds 보이는 순서(결과를 이 순서로 정렬한다).
 * @returns 옮길 id 배열(화면 순서).
 */
export function dragPayloadIds(
  selected: ReadonlySet<string>,
  draggedId: string,
  visibleIds: readonly string[],
): string[] {
  if (!selected.has(draggedId)) return [draggedId];
  const ordered = visibleIds.filter((id) => selected.has(id));
  return ordered.length > 0 ? ordered : [draggedId];
}

/* ── 고무줄(마퀴) 선택 ─────────────────────────────────────────── */

/**
 * 스크롤 컨테이너의 **내용 좌표계** 한 점.
 *
 * 화면 좌표(clientX/Y)를 그대로 쓰면 끌던 중 스크롤이 움직이면 어긋난다.
 * 그래서 `toContainerPoint()` 로 컨테이너 좌상단 + `scrollTop/Left` 기준으로 바꿔 쓴다.
 */
export interface Point {
  x: number;
  y: number;
}

/** 내용 좌표계 사각형. 항상 left<=right, top<=bottom. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 행 하나의 위치. `rect` 는 내용 좌표계. */
export interface RowBox {
  id: string;
  rect: Rect;
}

/** 이만큼(px) 움직이기 전에는 고무줄이 아니라 클릭으로 본다. */
export const MARQUEE_THRESHOLD_PX = 4;

/**
 * 이 mousedown 으로 고무줄을 시작해도 되는지.
 *
 * - 행 위에서 시작한 것은 기존 HTML5 드래그 이동이다(고무줄로 가로채면 이동이 깨진다).
 * - 버튼/입력 위에서 시작한 것은 그 컨트롤의 조작이다.
 * - 왼쪽 버튼만 받는다(오른쪽은 컨텍스트 메뉴).
 *
 * @param input `button` 은 MouseEvent.button, `onRow`/`onInteractive` 는 이벤트 대상 판별 결과.
 */
export function shouldStartMarquee(input: {
  button: number;
  onRow: boolean;
  onInteractive: boolean;
}): boolean {
  return input.button === 0 && !input.onRow && !input.onInteractive;
}

/**
 * 화면 좌표를 스크롤 컨테이너 내용 좌표로 바꾼다.
 *
 * @param client `clientX`/`clientY`.
 * @param container `getBoundingClientRect()` 의 left/top 과 현재 스크롤량.
 */
export function toContainerPoint(
  client: Point,
  container: { left: number; top: number; scrollLeft: number; scrollTop: number },
): Point {
  return {
    x: client.x - container.left + container.scrollLeft,
    y: client.y - container.top + container.scrollTop,
  };
}

/** 두 점으로 사각형을 만든다(어느 방향으로 끌어도 같은 결과). */
export function normalizeRect(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** 시작점에서 충분히 멀어졌는지(= 클릭이 아니라 고무줄인지). */
export function exceedsMarqueeThreshold(start: Point, current: Point): boolean {
  return (
    Math.abs(current.x - start.x) >= MARQUEE_THRESHOLD_PX ||
    Math.abs(current.y - start.y) >= MARQUEE_THRESHOLD_PX
  );
}

/** 두 사각형이 실제로 겹치는지. 변이 맞닿기만 한 경우는 겹치지 않은 것으로 본다. */
function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export interface MarqueeResult {
  selected: Set<string>;
  /** 이 고무줄이 잡은 첫 행(행 목록 순서 = 화면 순서). 아무것도 안 잡으면 null. */
  anchorId: string | null;
}

/**
 * 고무줄 사각형이 지금 덮고 있는 선택 상태를 계산한다.
 *
 * `base` 는 **고무줄을 시작한 순간의 선택**이다. 끌면서 매번 이 기준으로 다시
 * 계산하기 때문에 사각형을 줄이면 선택도 따라 풀린다(직전 결과에 누적하면
 * 한 번 잡힌 행이 영영 안 풀린다).
 *
 * @param input.base 시작 시점 선택. `additive` 가 false 면 무시된다.
 * @param input.rows 행 위치들(화면 순서).
 * @param input.rect 지금 고무줄 사각형.
 * @param input.additive Ctrl/Cmd 를 누른 채 끄는 중인지(기존 선택에 더한다).
 */
export function marqueeSelection(input: {
  base: ReadonlySet<string>;
  rows: readonly RowBox[];
  rect: Rect;
  additive: boolean;
}): MarqueeResult {
  const { base, rows, rect, additive } = input;
  const selected = additive ? new Set(base) : new Set<string>();
  let anchorId: string | null = null;

  for (const row of rows) {
    if (!rectsIntersect(rect, row.rect)) continue;
    if (anchorId == null) anchorId = row.id;
    selected.add(row.id);
  }

  return { selected, anchorId };
}

/**
 * `dataTransfer` 에 실린 값에서 노드 id 목록을 읽는다.
 *
 * 지금은 JSON 배열(`'["a","b"]'`)로 싣지만, 옛 버전은 id 하나를 그냥 문자열로
 * 실었다. 탭이 섞여 있는 상황(옛 화면에서 끌어 새 화면에 떨구기)에서도 사고가
 * 나지 않도록 파싱에 실패하면 단일 id 로 본다.
 *
 * @param raw `dataTransfer.getData(NODE_MIME)` 값.
 * @returns 노드 id 배열. 빈 값이면 빈 배열.
 */
export function parseDragIds(raw: string): string[] {
  const value = raw.trim();
  if (value === '') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string' && id !== '');
    }
    if (typeof parsed === 'string' && parsed !== '') return [parsed];
  } catch {
    // JSON 이 아니면 옛 형식(단일 id 문자열)이다.
  }
  return [value];
}
