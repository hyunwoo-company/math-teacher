import { describe, expect, it } from 'vitest';
import { buildTree, countDescendants, isDescendantOf, nodePath } from '@/lib/tree';
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
    file: { pages: 7, problem_count: 22, mode: 'text', pua_ratio: 0.02 },
  };
}

describe('buildTree', () => {
  it('플랫 배열을 중첩 트리로 만든다', () => {
    const nodes = [
      folder('a', '2026-1학기'),
      folder('b', '공통수학1', 'a'),
      file('c', '풍문고.pdf', 'b'),
    ];
    const roots = buildTree(nodes);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.node.id).toBe('a');
    expect(roots[0]?.children[0]?.node.id).toBe('b');
    expect(roots[0]?.children[0]?.children[0]?.node.id).toBe('c');
  });

  it('깊이를 0 부터 매긴다', () => {
    const roots = buildTree([folder('a', 'A'), folder('b', 'B', 'a'), folder('c', 'C', 'b')]);
    expect(roots[0]?.depth).toBe(0);
    expect(roots[0]?.children[0]?.depth).toBe(1);
    expect(roots[0]?.children[0]?.children[0]?.depth).toBe(2);
  });

  it('폴더를 파일보다 먼저, 이름은 자연 정렬한다', () => {
    const roots = buildTree([
      file('f2', '2번.pdf'),
      file('f10', '10번.pdf'),
      folder('z', '나중'),
      folder('a', '먼저'),
    ]);
    expect(roots.map((item) => item.node.name)).toEqual(['나중', '먼저', '2번.pdf', '10번.pdf']);
  });

  it('부모가 없는 고아 노드를 잃지 않고 루트로 올린다', () => {
    const roots = buildTree([file('x', '떠돌이.pdf', 'missing-parent')]);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.node.id).toBe('x');
  });

  it('순환 참조가 있어도 무한 루프에 빠지지 않는다', () => {
    const a = folder('a', 'A', 'b');
    const b = folder('b', 'B', 'a');
    const roots = buildTree([a, b]);
    expect(roots.length).toBeGreaterThan(0);
  });
});

describe('isDescendantOf / countDescendants / nodePath', () => {
  const nodes = [
    folder('root', '2026-1학기'),
    folder('sub', '공통수학1', 'root'),
    folder('sub2', '미적분', 'root'),
    file('leaf', '풍문고.pdf', 'sub'),
    folder('other', '모의고사'),
  ];

  it('자손 여부를 판정한다', () => {
    expect(isDescendantOf(nodes, 'root', 'leaf')).toBe(true);
    expect(isDescendantOf(nodes, 'sub', 'leaf')).toBe(true);
    expect(isDescendantOf(nodes, 'other', 'leaf')).toBe(false);
    expect(isDescendantOf(nodes, 'leaf', 'root')).toBe(false);
  });

  it('삭제 경고에 쓸 하위 개수를 센다', () => {
    expect(countDescendants(nodes, 'root')).toEqual({ folders: 2, files: 1 });
    expect(countDescendants(nodes, 'other')).toEqual({ folders: 0, files: 0 });
  });

  it('경로를 만든다', () => {
    expect(nodePath(nodes, 'leaf')).toEqual(['2026-1학기', '공통수학1', '풍문고.pdf']);
  });
});
