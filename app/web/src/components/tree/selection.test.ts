import { describe, expect, it } from 'vitest';
import { buildTree } from '@/lib/tree';
import type { TreeNode } from '@/types/api';
import {
  dragPayloadIds,
  nextSelection,
  parseDragIds,
  visibleNodeIds,
} from '@/components/tree/selection';

const CREATED_AT = '2026-08-14T00:00:00Z';

function folder(id: string, name: string, parentId: string | null): TreeNode {
  return { id, name, type: 'folder', parent_id: parentId, created_at: CREATED_AT };
}

function file(id: string, name: string, parentId: string | null): TreeNode {
  return { id, name, type: 'file', parent_id: parentId, created_at: CREATED_AT };
}

// a(폴더) > a1, a2 / b(폴더) > b1 / c(파일)
const NODES: TreeNode[] = [
  folder('a', '1학기', null),
  file('a1', '1차 지필.pdf', 'a'),
  file('a2', '2차 지필.pdf', 'a'),
  folder('b', '2학기', null),
  file('b1', '기말.pdf', 'b'),
  file('c', '단독.pdf', null),
];

const ROOTS = buildTree(NODES);

describe('visibleNodeIds', () => {
  it('펼친 폴더의 자식만 화면 순서대로 준다', () => {
    expect(visibleNodeIds(ROOTS, { a: true, b: true })).toEqual([
      'a',
      'a1',
      'a2',
      'b',
      'b1',
      'c',
    ]);
  });

  it('접힌 폴더의 자식은 목록에서 빠진다', () => {
    expect(visibleNodeIds(ROOTS, { a: false, b: true })).toEqual(['a', 'b', 'b1', 'c']);
  });
});

describe('nextSelection', () => {
  const visibleIds = visibleNodeIds(ROOTS, { a: true, b: true });

  it('그냥 클릭은 선택을 그 하나로 리셋한다', () => {
    const result = nextSelection({
      current: new Set(['a1', 'a2']),
      anchorId: 'a1',
      clickedId: 'b1',
      modifiers: { toggle: false, range: false },
      visibleIds,
    });
    expect([...result.selected]).toEqual(['b1']);
    expect(result.anchorId).toBe('b1');
  });

  it('Ctrl 클릭은 그 행만 켜고 끈다', () => {
    const added = nextSelection({
      current: new Set(['a1']),
      anchorId: 'a1',
      clickedId: 'b1',
      modifiers: { toggle: true, range: false },
      visibleIds,
    });
    expect([...added.selected].sort()).toEqual(['a1', 'b1']);

    const removed = nextSelection({
      current: added.selected,
      anchorId: added.anchorId,
      clickedId: 'a1',
      modifiers: { toggle: true, range: false },
      visibleIds,
    });
    expect([...removed.selected]).toEqual(['b1']);
  });

  it('Shift 클릭은 기준점부터 화면 순서로 범위를 잡고 기준점을 유지한다', () => {
    const result = nextSelection({
      current: new Set(['a1']),
      anchorId: 'a1',
      clickedId: 'b',
      modifiers: { toggle: false, range: true },
      visibleIds,
    });
    expect([...result.selected]).toEqual(['a1', 'a2', 'b']);
    expect(result.anchorId).toBe('a1');
  });

  it('위로 거슬러 올라가는 Shift 클릭도 같은 범위를 잡는다', () => {
    const result = nextSelection({
      current: new Set(),
      anchorId: 'b1',
      clickedId: 'a2',
      modifiers: { toggle: false, range: true },
      visibleIds,
    });
    expect([...result.selected]).toEqual(['a2', 'b', 'b1']);
  });

  it('접힌 폴더의 자식은 범위에 들어오지 않는다', () => {
    const collapsed = visibleNodeIds(ROOTS, { a: false, b: true });
    const result = nextSelection({
      current: new Set(),
      anchorId: 'a',
      clickedId: 'b1',
      modifiers: { toggle: false, range: true },
      visibleIds: collapsed,
    });
    expect([...result.selected]).toEqual(['a', 'b', 'b1']);
  });

  it('Ctrl+Shift 클릭은 기존 선택에 범위를 더한다', () => {
    const result = nextSelection({
      current: new Set(['c']),
      anchorId: 'a1',
      clickedId: 'a2',
      modifiers: { toggle: true, range: true },
      visibleIds,
    });
    expect([...result.selected].sort()).toEqual(['a1', 'a2', 'c']);
  });

  it('기준점이 없으면 Shift 클릭도 단일 선택이 된다', () => {
    const result = nextSelection({
      current: new Set(['a1']),
      anchorId: null,
      clickedId: 'b1',
      modifiers: { toggle: false, range: true },
      visibleIds,
    });
    expect([...result.selected]).toEqual(['b1']);
  });
});

describe('dragPayloadIds', () => {
  const visibleIds = visibleNodeIds(ROOTS, { a: true, b: true });

  it('끌기 시작한 행이 선택에 있으면 선택 전체를 화면 순서로 싣는다', () => {
    expect(dragPayloadIds(new Set(['b1', 'a1']), 'a1', visibleIds)).toEqual(['a1', 'b1']);
  });

  it('선택 밖의 행을 끌면 그 행 하나만 옮긴다', () => {
    expect(dragPayloadIds(new Set(['a1', 'a2']), 'c', visibleIds)).toEqual(['c']);
  });
});

describe('parseDragIds', () => {
  it('JSON 배열 형식을 읽는다', () => {
    expect(parseDragIds('["a","b"]')).toEqual(['a', 'b']);
  });

  it('옛 단일 id 문자열도 그대로 받아 준다', () => {
    expect(parseDragIds('folder-2026-1')).toEqual(['folder-2026-1']);
  });

  it('빈 값이면 아무것도 옮기지 않는다', () => {
    expect(parseDragIds('')).toEqual([]);
    expect(parseDragIds('   ')).toEqual([]);
  });

  it('배열 안의 문자열이 아닌 값은 버린다', () => {
    expect(parseDragIds('[1,"a",null]')).toEqual(['a']);
  });
});
