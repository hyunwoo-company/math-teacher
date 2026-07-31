/**
 * 업로드 대상 결정 테스트.
 *
 * 실사용 버그: `test-hw` 폴더를 만들고 올렸는데 루트로 들어갔다.
 * 대상이 틀리면 사용자는 "비어 있음" 만 보고 원인을 알 수 없으므로 규칙을 여기서 잠근다.
 */

import { describe, expect, it } from 'vitest';
import {
  ROOT_LABEL,
  resolveDropTarget,
  resolveUploadTarget,
  uploadTargetLabel,
} from '@/lib/upload-target';
import type { TreeNode } from '@/types/api';

function folder(id: string, name: string, parent: string | null = null): TreeNode {
  return { id, type: 'folder', name, parent_id: parent, created_at: '2026-07-31T00:00:00+09:00' };
}

function file(id: string, name: string, parent: string | null = null): TreeNode {
  return {
    id,
    type: 'file',
    name,
    parent_id: parent,
    created_at: '2026-07-31T00:00:00+09:00',
    file: { pages: 7, problem_count: 22, mode: 'image', pua_ratio: 0.39 },
  };
}

/** 사용자의 실제 데이터 구조: test-hw 폴더 + 루트에 잘못 올라간 PDF */
const nodes: TreeNode[] = [
  folder('c8ad1593dedb', 'test-hw'),
  folder('sub', '중간고사', 'c8ad1593dedb'),
  file('9259f0cf2e6d', '[2026-1-1-M][공수1][풍문고].pdf'),
  file('inner', '기말.pdf', 'sub'),
];

describe('resolveDropTarget — 드래그&드롭', () => {
  it('폴더 위에 떨구면 그 폴더로 올라간다', () => {
    expect(resolveDropTarget(nodes, 'c8ad1593dedb')).toEqual({
      folderId: 'c8ad1593dedb',
      label: 'test-hw',
    });
  });

  it('중첩 폴더 위에 떨구면 그 하위 폴더로 올라간다', () => {
    expect(resolveDropTarget(nodes, 'sub')).toEqual({ folderId: 'sub', label: '중간고사' });
  });

  it('파일 위에 떨구면 그 파일이 들어 있는 폴더로 올라간다', () => {
    expect(resolveDropTarget(nodes, 'inner')).toEqual({ folderId: 'sub', label: '중간고사' });
  });

  it('루트에 있는 파일 위에 떨구면 루트로 올라간다', () => {
    expect(resolveDropTarget(nodes, '9259f0cf2e6d')).toEqual({
      folderId: null,
      label: ROOT_LABEL,
    });
  });

  it('빈 영역(null)에 떨구면 루트로 올라간다', () => {
    expect(resolveDropTarget(nodes, null)).toEqual({ folderId: null, label: ROOT_LABEL });
  });

  it('없는 노드 id 면 루트로 본다', () => {
    expect(resolveDropTarget(nodes, 'ghost')).toEqual({ folderId: null, label: ROOT_LABEL });
  });
});

describe('resolveUploadTarget — 하단 버튼', () => {
  it('폴더를 선택해 두면 그 폴더가 대상이다', () => {
    expect(resolveUploadTarget(nodes, 'c8ad1593dedb', null)).toEqual({
      folderId: 'c8ad1593dedb',
      label: 'test-hw',
    });
  });

  it('파일에 포커스가 있으면 그 파일의 부모 폴더가 대상이다', () => {
    expect(resolveUploadTarget(nodes, 'inner', null)).toEqual({
      folderId: 'sub',
      label: '중간고사',
    });
  });

  it('포커스가 없고 파일만 열려 있으면 그 파일의 부모 폴더가 대상이다', () => {
    expect(resolveUploadTarget(nodes, null, 'inner')).toEqual({
      folderId: 'sub',
      label: '중간고사',
    });
  });

  it('아무것도 없으면 루트가 대상이다', () => {
    expect(resolveUploadTarget(nodes, null, null)).toEqual({
      folderId: null,
      label: ROOT_LABEL,
    });
  });

  it('포커스가 파일이면 열려 있는 파일보다 포커스를 우선한다', () => {
    expect(resolveUploadTarget(nodes, 'c8ad1593dedb', 'inner')).toEqual({
      folderId: 'c8ad1593dedb',
      label: 'test-hw',
    });
  });

  it('삭제된 노드에 포커스가 남아 있어도 루트로 안전하게 떨어진다', () => {
    expect(resolveUploadTarget(nodes, 'deleted-id', null)).toEqual({
      folderId: null,
      label: ROOT_LABEL,
    });
  });

  it('루트 파일이 열려 있으면 대상은 루트다', () => {
    expect(resolveUploadTarget(nodes, null, '9259f0cf2e6d')).toEqual({
      folderId: null,
      label: ROOT_LABEL,
    });
  });
});

describe('uploadTargetLabel', () => {
  it('폴더 이름을 그대로 쓴다', () => {
    expect(uploadTargetLabel(nodes, 'c8ad1593dedb')).toBe('test-hw');
  });

  it('null 이면 최상위', () => {
    expect(uploadTargetLabel(nodes, null)).toBe(ROOT_LABEL);
  });

  it('폴더가 아닌 id 를 주면 최상위로 본다(잘못된 상태 방어)', () => {
    expect(uploadTargetLabel(nodes, '9259f0cf2e6d')).toBe(ROOT_LABEL);
  });
});
