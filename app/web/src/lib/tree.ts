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
