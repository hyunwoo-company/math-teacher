import { describe, expect, it } from 'vitest';
import { buildTree } from '@/lib/tree';
import type { TreeNode } from '@/types/api';
import {
  MARQUEE_THRESHOLD_PX,
  dragPayloadIds,
  exceedsMarqueeThreshold,
  marqueeSelection,
  nextSelection,
  normalizeRect,
  parseDragIds,
  shouldStartMarquee,
  toContainerPoint,
  visibleNodeIds,
  type RowBox,
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

/* ── 고무줄(마퀴) 선택 ─────────────────────────────────────────── */

describe('shouldStartMarquee', () => {
  it('빈 공간에서 왼쪽 버튼을 누르면 고무줄을 시작한다', () => {
    expect(shouldStartMarquee({ button: 0, onRow: false, onInteractive: false })).toBe(true);
  });

  it('행 위에서 누르면 고무줄이 아니다 (HTML5 드래그 이동이 살아야 한다)', () => {
    expect(shouldStartMarquee({ button: 0, onRow: true, onInteractive: false })).toBe(false);
  });

  it('버튼/입력 위에서 누르면 고무줄이 아니다', () => {
    expect(shouldStartMarquee({ button: 0, onRow: false, onInteractive: true })).toBe(false);
  });

  it('오른쪽 버튼(컨텍스트 메뉴)은 고무줄이 아니다', () => {
    expect(shouldStartMarquee({ button: 2, onRow: false, onInteractive: false })).toBe(false);
  });
});

describe('toContainerPoint', () => {
  it('컨테이너 위치와 스크롤량을 함께 반영한다', () => {
    expect(
      toContainerPoint({ x: 120, y: 300 }, { left: 20, top: 100, scrollLeft: 0, scrollTop: 40 }),
    ).toEqual({ x: 100, y: 240 });
  });
});

describe('normalizeRect', () => {
  it('아래로 끈 경우를 그대로 담는다', () => {
    expect(normalizeRect({ x: 10, y: 20 }, { x: 40, y: 90 })).toEqual({
      left: 10,
      top: 20,
      right: 40,
      bottom: 90,
    });
  });

  it('위로/왼쪽으로 끌어도 같은 사각형이 된다', () => {
    expect(normalizeRect({ x: 40, y: 90 }, { x: 10, y: 20 })).toEqual({
      left: 10,
      top: 20,
      right: 40,
      bottom: 90,
    });
  });
});

describe('exceedsMarqueeThreshold', () => {
  it('임계값 미만이면 클릭으로 본다', () => {
    const start = { x: 10, y: 10 };
    const nudge = { x: 10 + MARQUEE_THRESHOLD_PX - 1, y: 10 };
    expect(exceedsMarqueeThreshold(start, nudge)).toBe(false);
  });

  it('세로로만 임계값을 넘겨도 고무줄로 본다', () => {
    expect(exceedsMarqueeThreshold({ x: 10, y: 10 }, { x: 10, y: 10 + MARQUEE_THRESHOLD_PX })).toBe(
      true,
    );
  });
});

describe('marqueeSelection', () => {
  // 24px 짜리 행 4개가 세로로 쌓인 트리 (컨테이너 내용 좌표계).
  const ROWS: RowBox[] = ['a', 'a1', 'a2', 'b'].map((id, index) => ({
    id,
    rect: { left: 0, top: index * 24, right: 200, bottom: index * 24 + 24 },
  }));

  it('사각형과 겹치는 행만 선택한다', () => {
    const result = marqueeSelection({
      base: new Set(),
      rows: ROWS,
      rect: { left: 5, top: 30, right: 60, bottom: 70 },
      additive: false,
    });
    expect([...result.selected]).toEqual(['a1', 'a2']);
  });

  it('겹치지 않는 행은 빠지고, 잡은 첫 행이 다음 기준점이 된다', () => {
    const result = marqueeSelection({
      base: new Set(),
      rows: ROWS,
      rect: { left: 0, top: 50, right: 10, bottom: 60 },
      additive: false,
    });
    expect([...result.selected]).toEqual(['a2']);
    expect(result.anchorId).toBe('a2');
  });

  it('가로로 빗나가면 아무 행도 잡지 않는다', () => {
    const result = marqueeSelection({
      base: new Set(),
      rows: ROWS,
      rect: { left: 240, top: 0, right: 300, bottom: 100 },
      additive: false,
    });
    expect([...result.selected]).toEqual([]);
    expect(result.anchorId).toBeNull();
  });

  it('Ctrl 고무줄은 시작 시점의 선택에 더한다', () => {
    const result = marqueeSelection({
      base: new Set(['b']),
      rows: ROWS,
      rect: { left: 0, top: 0, right: 200, bottom: 10 },
      additive: true,
    });
    expect([...result.selected].sort()).toEqual(['a', 'b']);
  });

  it('Ctrl 없이 끌면 기존 선택을 버리고 새로 잡는다', () => {
    const result = marqueeSelection({
      base: new Set(['b']),
      rows: ROWS,
      rect: { left: 0, top: 0, right: 200, bottom: 10 },
      additive: false,
    });
    expect([...result.selected]).toEqual(['a']);
  });

  it('사각형을 줄이면 시작 시점 기준으로 다시 계산해 선택이 풀린다', () => {
    const wide = marqueeSelection({
      base: new Set(),
      rows: ROWS,
      rect: { left: 0, top: 0, right: 200, bottom: 100 },
      additive: false,
    });
    expect(wide.selected.size).toBe(4);

    const narrowed = marqueeSelection({
      base: new Set(),
      rows: ROWS,
      rect: { left: 0, top: 0, right: 200, bottom: 10 },
      additive: false,
    });
    expect([...narrowed.selected]).toEqual(['a']);
  });

  it('맞닿기만 한 경계는 선택하지 않는다', () => {
    const result = marqueeSelection({
      base: new Set(),
      rows: ROWS,
      rect: { left: 0, top: 24, right: 200, bottom: 24 },
      additive: false,
    });
    expect([...result.selected]).toEqual([]);
  });
});
