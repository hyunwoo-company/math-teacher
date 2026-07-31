/**
 * "이 파일이 어느 폴더로 업로드되는가" 를 한 곳에서 결정한다.
 *
 * 실사용 버그 배경: 사용자가 `test-hw` 폴더를 만들고 PDF 를 올렸는데 루트로 들어갔다.
 * 폴더로 올리는 경로가 우클릭 메뉴 하나뿐이었고, 하단 버튼과 드래그&드롭이
 * 모두 루트로 하드코딩돼 있었기 때문이다.
 *
 * 규칙을 순수 함수로 뽑아 UI 세 곳(버튼/드롭/컨텍스트 메뉴)이 같은 답을 쓰게 한다.
 */

import type { TreeNode } from '@/types/api';

/** 루트를 뜻하는 표시 이름. */
export const ROOT_LABEL = '최상위';

export interface UploadTarget {
  /** 업로드 대상 폴더 id. null 이면 루트. */
  folderId: string | null;
  /** 버튼 옆에 보여줄 대상 이름. */
  label: string;
}

function findNode(nodes: readonly TreeNode[], id: string | null): TreeNode | undefined {
  if (id == null) return undefined;
  return nodes.find((node) => node.id === id);
}

/** 폴더 id -> 표시 이름. 없는 폴더면 루트로 본다. */
export function uploadTargetLabel(nodes: readonly TreeNode[], folderId: string | null): string {
  const node = findNode(nodes, folderId);
  if (!node || node.type !== 'folder') return ROOT_LABEL;
  return node.name;
}

function toTarget(nodes: readonly TreeNode[], folderId: string | null): UploadTarget {
  return { folderId, label: uploadTargetLabel(nodes, folderId) };
}

/**
 * 어떤 노드 "위에" 파일을 떨궜을 때의 대상 폴더.
 *
 * - 폴더 위    -> 그 폴더
 * - 파일 위    -> 그 파일이 들어 있는 폴더 (사용자 의도는 "이 옆에 넣기" 다)
 * - 빈 영역    -> 루트 (`dropNodeId === null`)
 * - 없는 노드  -> 루트
 */
export function resolveDropTarget(
  nodes: readonly TreeNode[],
  dropNodeId: string | null,
): UploadTarget {
  const node = findNode(nodes, dropNodeId);
  if (!node) return toTarget(nodes, null);
  if (node.type === 'folder') return toTarget(nodes, node.id);
  return toTarget(nodes, node.parent_id);
}

/**
 * 하단 [+ 파일 업로드] 버튼의 대상 폴더.
 *
 * 우선순위:
 *  1. 트리에서 마지막으로 선택/포커스한 폴더
 *  2. (포커스가 파일이면) 그 파일의 부모 폴더
 *  3. 열려 있는 파일의 부모 폴더
 *  4. 루트
 */
export function resolveUploadTarget(
  nodes: readonly TreeNode[],
  focusedNodeId: string | null,
  selectedFileId: string | null,
): UploadTarget {
  const focused = findNode(nodes, focusedNodeId);
  if (focused) {
    if (focused.type === 'folder') return toTarget(nodes, focused.id);
    return toTarget(nodes, focused.parent_id);
  }

  const selected = findNode(nodes, selectedFileId);
  if (selected) return toTarget(nodes, selected.parent_id);

  return toTarget(nodes, null);
}
