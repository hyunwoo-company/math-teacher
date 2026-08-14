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
