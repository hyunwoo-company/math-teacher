/**
 * "우클릭 → 이동…" 다이얼로그가 보여 줄 **대상 폴더 목록**을 만든다.
 *
 * 드래그로는 닿기 힘든 깊은 트리를 위한 대안이라, 규칙은 드래그 이동과 똑같아야 한다:
 * 자기 자신·자손으로는 못 가고(트리가 끊어진다), 섹션(시험지/오답노트)을 넘지 못하며
 * (서버가 400 으로 거부한다), 제자리 이동은 의미가 없다.
 *
 * 화면 로직을 섞지 않기 위해 순수 함수로 둔다. 실제 이동은 스토어의 `moveNodes` 가 한다.
 */

import { buildTree, isDescendantOf, type TreeItem } from '@/lib/tree';
import type { Section, TreeNode } from '@/types/api';

/** 목록의 한 줄. `id === null` 이면 최상위. */
export interface MoveTarget {
  /** 대상 폴더 id. 최상위는 `null`. */
  id: string | null;
  /** 화면에 그릴 이름. 최상위는 `(최상위)`. */
  name: string;
  /** 들여쓰기 단계(최상위는 0, 루트 폴더도 0). */
  depth: number;
  /** 고를 수 없으면 true. */
  disabled: boolean;
  /** 고를 수 없는 이유(짧은 한국어). 화면에서 `(…)` 로 덧붙인다. */
  reason?: string;
}

export const MOVE_ROOT_LABEL = '(최상위)';

const REASON_SELF = '옮길 항목';
const REASON_DESCENDANT = '하위 폴더';
const REASON_CURRENT = '현재 위치';

/**
 * 이동 대상 후보. 항상 최상위가 첫 줄이고, 그 아래로 폴더가 트리 순서대로 온다.
 *
 * - **폴더만** 대상이 된다. 시험지·오답노트 파일 노드는 무엇도 담을 수 없다.
 * - 다른 섹션 폴더는 아예 빼 버린다(옮길 수 없으니 보여 줄 이유도 없다).
 *   `section` 필드가 없는 구버전 응답은 지금 보고 있는 섹션의 것으로 친다 —
 *   스토어의 `nodes` 는 이미 섹션별로 받아 온 목록이다.
 * - 다음은 목록에 남기되 `disabled` 로 이유를 밝힌다(사라지면 왜 못 고르는지 알 수 없다):
 *   옮기는 폴더 자신, 그 자손, 그리고 **옮기는 것 전부의 현재 부모**.
 *   일부만 그 폴더에 있다면 나머지는 실제로 움직이므로 막지 않는다.
 */
export function moveTargets(input: {
  nodes: readonly TreeNode[];
  movingIds: readonly string[];
  section: Section;
}): MoveTarget[] {
  const { nodes, movingIds, section } = input;
  const moving = new Set(movingIds);
  const movingNodes = nodes.filter((node) => moving.has(node.id));

  /** 옮기는 것이 전부 이 부모 밑에 있으면 제자리 이동이다. */
  const isCurrentParent = (parentId: string | null): boolean =>
    movingNodes.length > 0 && movingNodes.every((node) => node.parent_id === parentId);

  const rootDisabled = isCurrentParent(null);
  const targets: MoveTarget[] = [
    {
      id: null,
      name: MOVE_ROOT_LABEL,
      depth: 0,
      disabled: rootDisabled,
      ...(rootDisabled ? { reason: REASON_CURRENT } : {}),
    },
  ];

  const folders = nodes.filter(
    (node) => node.type === 'folder' && (node.section ?? section) === section,
  );

  // 트리 조립·정렬(폴더 먼저, 이름 자연 정렬)은 좌측 트리와 같은 함수를 쓴다.
  // 그래야 다이얼로그의 줄 순서가 화면에서 보던 순서와 어긋나지 않는다.
  const push = (items: readonly TreeItem[]): void => {
    for (const item of items) {
      targets.push(toTarget(item, nodes, moving, movingIds, isCurrentParent));
      push(item.children);
    }
  };
  push(buildTree(folders));

  return targets;
}

function toTarget(
  item: TreeItem,
  nodes: readonly TreeNode[],
  moving: ReadonlySet<string>,
  movingIds: readonly string[],
  isCurrentParent: (parentId: string | null) => boolean,
): MoveTarget {
  const { node, depth } = item;
  const base = { id: node.id, name: node.name, depth };

  if (moving.has(node.id)) {
    return { ...base, disabled: true, reason: REASON_SELF };
  }
  // 자손으로 옮기면 그 가지가 트리에서 통째로 떨어져 나간다. 스토어·서버도 막지만
  // (`moveNodes` 의 `isDescendantOf`, 서버의 cycle_detected) 고를 수 있게 두면 안 된다.
  if (movingIds.some((id) => isDescendantOf(nodes, id, node.id))) {
    return { ...base, disabled: true, reason: REASON_DESCENDANT };
  }
  if (isCurrentParent(node.id)) {
    return { ...base, disabled: true, reason: REASON_CURRENT };
  }
  return { ...base, disabled: false };
}
