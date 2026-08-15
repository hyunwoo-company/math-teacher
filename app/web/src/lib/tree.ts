/**
 * `GET /api/tree` 의 플랫 배열을 트리로 조립한다. (중첩 무제한)
 */

import type { TreeNode } from '@/types/api';

export interface TreeItem {
  node: TreeNode;
  depth: number;
  children: TreeItem[];
}

const collator = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });

/** 폴더 먼저, 그 다음 이름 오름차순(숫자 자연 정렬). */
function compareNodes(a: TreeItem, b: TreeItem): number {
  if (a.node.type !== b.node.type) return a.node.type === 'folder' ? -1 : 1;
  return collator.compare(a.node.name, b.node.name);
}

/**
 * 플랫 배열 -> 루트 TreeItem 배열.
 *
 * - `parent_id === null` 이 루트.
 * - 부모가 목록에 없는 노드(고아)는 유실시키지 않고 루트로 올린다.
 * - 순환 참조가 있으면 그 노드는 루트로 올린다(무한 루프 방지).
 */
export function buildTree(nodes: readonly TreeNode[]): TreeItem[] {
  const items = new Map<string, TreeItem>();
  for (const node of nodes) {
    items.set(node.id, { node, depth: 0, children: [] });
  }

  const roots: TreeItem[] = [];

  for (const item of items.values()) {
    const parentId = item.node.parent_id;
    const parent = parentId == null ? undefined : items.get(parentId);
    if (!parent || parent === item || isDescendant(items, parent.node.id, item.node.id)) {
      roots.push(item);
      continue;
    }
    parent.children.push(item);
  }

  const assignDepth = (list: TreeItem[], depth: number): void => {
    list.sort(compareNodes);
    for (const item of list) {
      item.depth = depth;
      assignDepth(item.children, depth + 1);
    }
  };
  assignDepth(roots, 0);

  return roots;
}

/** `candidateId` 가 `nodeId` 의 자손인지. (순환/자기이동 방지용) */
export function isDescendant(
  items: Map<string, TreeItem>,
  candidateId: string,
  nodeId: string,
): boolean {
  let current = items.get(candidateId);
  let guard = 0;
  while (current && guard < 10_000) {
    const parentId = current.node.parent_id;
    if (parentId == null) return false;
    if (parentId === nodeId) return true;
    current = items.get(parentId);
    guard += 1;
  }
  return false;
}

/** 플랫 배열 기준으로 `maybeChildId` 가 `ancestorId` 의 자손인지. */
export function isDescendantOf(
  nodes: readonly TreeNode[],
  ancestorId: string,
  maybeChildId: string,
): boolean {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let current = byId.get(maybeChildId);
  let guard = 0;
  while (current && guard < 10_000) {
    if (current.parent_id === ancestorId) return true;
    if (current.parent_id == null) return false;
    current = byId.get(current.parent_id);
    guard += 1;
  }
  return false;
}

/** 노드의 경로 이름 배열 (`['2026-1학기','공통수학1','풍문고.pdf']`). */
export function nodePath(nodes: readonly TreeNode[], id: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const path: string[] = [];
  let current = byId.get(id);
  let guard = 0;
  while (current && guard < 10_000) {
    path.unshift(current.name);
    if (current.parent_id == null) break;
    current = byId.get(current.parent_id);
    guard += 1;
  }
  return path;
}

/**
 * 이름 검색어를 다듬는다. 공백뿐이면 `null`(= 필터 없음).
 * 검색은 이름 부분일치만 본다(문항 내용은 대상이 아니다).
 */
function normalizeQuery(query: string): string | null {
  const trimmed = query.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * 정규식 특수문자를 이스케이프한다.
 * 사용자가 친 `a.pdf` 의 `.` 는 "아무 글자"가 아니라 점 그대로여야 하고,
 * `(1)` 같은 입력이 정규식 문법 오류로 터지지 않아야 한다.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 이름이 검색어와 부분일치하는 노드 id 집합.
 *
 * - 검색어가 비었거나 공백뿐이면 `null` = **필터 없음**(전체를 그대로 그린다).
 *   빈 `Set` 은 "일치 없음"이라는 다른 뜻이므로 둘을 섞지 않는다.
 * - 일치한 노드의 **조상**을 모두 넣는다. 안 넣으면 트리 경로가 끊겨 화면에서 사라진다.
 * - 일치한 것이 폴더면 그 **자손 전부**를 넣는다(폴더를 찾으면 안을 보고 싶은 게 보통이다).
 * - 대소문자는 무시한다. 한글은 그대로 부분일치.
 */
export function matchNodeIds(nodes: readonly TreeNode[], query: string): Set<string> | null {
  const needle = normalizeQuery(query);
  if (needle == null) return null;

  const pattern = new RegExp(escapeRegExp(needle), 'i');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    if (node.parent_id == null) continue;
    const siblings = childrenOf.get(node.parent_id);
    if (siblings) siblings.push(node);
    else childrenOf.set(node.parent_id, [node]);
  }

  const matched = new Set<string>();

  for (const node of nodes) {
    if (!pattern.test(node.name)) continue;
    matched.add(node.id);

    // 조상 경로. 순환 참조가 있어도 visited 로 멈춘다.
    let parentId = node.parent_id;
    while (parentId != null && !matched.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      matched.add(parent.id);
      parentId = parent.parent_id;
    }

    if (node.type !== 'folder') continue;
    // 자손 전부(너비 우선). 이미 넣은 id 는 다시 펼치지 않는다.
    const queue = [...(childrenOf.get(node.id) ?? [])];
    while (queue.length > 0) {
      const child = queue.shift();
      if (!child || matched.has(child.id)) continue;
      matched.add(child.id);
      queue.push(...(childrenOf.get(child.id) ?? []));
    }
  }

  return matched;
}

/**
 * 조립된 트리에서 `ids` 에 없는 가지를 쳐 낸다.
 * `ids` 가 `null`(필터 없음)이면 그대로 돌려준다. `depth` 는 원래 값을 유지한다.
 */
export function filterTreeItems(items: TreeItem[], ids: ReadonlySet<string> | null): TreeItem[] {
  if (ids == null) return items;
  const kept: TreeItem[] = [];
  for (const item of items) {
    if (!ids.has(item.node.id)) continue;
    kept.push({ ...item, children: filterTreeItems(item.children, ids) });
  }
  return kept;
}

/** `splitHighlight` 의 한 조각. `hit` 인 조각만 강조해 그린다. */
export interface HighlightPart {
  text: string;
  hit: boolean;
}

/**
 * 이름을 [일치 전, 일치, 일치 후] 조각으로 쪼갠다. 하이라이트 렌더용.
 *
 * 문자열 조각만 돌려준다 — HTML 을 만들지 않으므로 `dangerouslySetInnerHTML` 이 필요 없다.
 * 일치가 없거나 검색어가 비면 원문 한 조각(`hit: false`)만 돌려준다.
 */
export function splitHighlight(name: string, query: string): HighlightPart[] {
  const needle = normalizeQuery(query);
  if (needle == null) return [{ text: name, hit: false }];

  const pattern = new RegExp(escapeRegExp(needle), 'gi');
  const parts: HighlightPart[] = [];
  let cursor = 0;
  let match = pattern.exec(name);
  while (match) {
    const hitText = match[0] ?? '';
    if (hitText === '') break;
    if (match.index > cursor) parts.push({ text: name.slice(cursor, match.index), hit: false });
    parts.push({ text: hitText, hit: true });
    cursor = match.index + hitText.length;
    match = pattern.exec(name);
  }

  if (parts.length === 0) return [{ text: name, hit: false }];
  if (cursor < name.length) parts.push({ text: name.slice(cursor), hit: false });
  return parts;
}

/** 폴더 삭제 경고용: 하위 노드 개수(폴더/파일). */
export function countDescendants(
  nodes: readonly TreeNode[],
  id: string,
): { folders: number; files: number } {
  let folders = 0;
  let files = 0;
  for (const node of nodes) {
    if (node.id === id) continue;
    if (!isDescendantOf(nodes, id, node.id)) continue;
    if (node.type === 'folder') folders += 1;
    else files += 1;
  }
  return { folders, files };
}
