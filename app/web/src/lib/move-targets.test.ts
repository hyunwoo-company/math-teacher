/**
 * "이동…" 다이얼로그의 대상 목록 규칙.
 *
 * 가장 중요한 것은 **자기 자신·자손을 고를 수 없다**는 것이다. 그게 뚫리면
 * 옮긴 가지가 트리에서 통째로 떨어져 나가 화면에서 사라진다.
 */

import { describe, expect, it } from 'vitest';
import { moveTargets, MOVE_ROOT_LABEL } from '@/lib/move-targets';
import type { Section, TreeNode } from '@/types/api';

const CREATED_AT = '2026-08-01T00:00:00+09:00';

function folder(
  id: string,
  name: string,
  parentId: string | null,
  section: Section = 'exam',
): TreeNode {
  return { id, type: 'folder', name, parent_id: parentId, section, created_at: CREATED_AT };
}

function file(
  id: string,
  name: string,
  parentId: string | null,
  section: Section = 'exam',
): TreeNode {
  return { id, type: 'file', name, parent_id: parentId, section, created_at: CREATED_AT };
}

/**
 * 시험지: 학기 > (공통수학2, 미적분 > 심화), 모의고사, 파일 1개.
 * 오답노트: 학생 폴더 1개.
 */
function sampleNodes(): TreeNode[] {
  return [
    folder('term', '2025-2학기', null),
    folder('common2', '공통수학2', 'term'),
    folder('calculus', '미적분', 'term'),
    folder('deep', '심화', 'calculus'),
    folder('mock', '모의고사', null),
    file('exam-pdf', '풍문고.pdf', 'common2'),
    folder('student', '이현우', null, 'note'),
    file('note-1', '중간고사 오답', 'student', 'note'),
  ];
}

/** 편의: id 로 한 줄 찾기. */
function row(targets: ReturnType<typeof moveTargets>, id: string | null) {
  return targets.find((target) => target.id === id);
}

describe('moveTargets', () => {
  it('최상위가 항상 첫 줄로 들어간다', () => {
    const targets = moveTargets({ nodes: sampleNodes(), movingIds: ['deep'], section: 'exam' });
    expect(targets[0]).toMatchObject({ id: null, name: MOVE_ROOT_LABEL, depth: 0, disabled: false });
  });

  it('옮기는 폴더 자신과 그 자손은 고를 수 없다', () => {
    const targets = moveTargets({ nodes: sampleNodes(), movingIds: ['calculus'], section: 'exam' });

    expect(row(targets, 'calculus')).toMatchObject({ disabled: true, reason: '옮길 항목' });
    expect(row(targets, 'deep')).toMatchObject({ disabled: true, reason: '하위 폴더' });
    // 형제·다른 가지는 그대로 고를 수 있다.
    expect(row(targets, 'common2')?.disabled).toBe(false);
    expect(row(targets, 'mock')?.disabled).toBe(false);
  });

  it('현재 부모는 고를 수 없고 이유가 붙는다', () => {
    const targets = moveTargets({ nodes: sampleNodes(), movingIds: ['deep'], section: 'exam' });
    expect(row(targets, 'calculus')).toMatchObject({ disabled: true, reason: '현재 위치' });
    expect(row(targets, null)?.disabled).toBe(false);
  });

  it('다른 섹션 폴더는 목록에 없다', () => {
    const exam = moveTargets({ nodes: sampleNodes(), movingIds: ['deep'], section: 'exam' });
    expect(row(exam, 'student')).toBeUndefined();

    const note = moveTargets({ nodes: sampleNodes(), movingIds: ['note-1'], section: 'note' });
    expect(note.map((target) => target.id)).toEqual([null, 'student']);
  });

  it('섹션 필드가 없는 구버전 노드는 지금 보고 있는 섹션의 것으로 친다', () => {
    const nodes: TreeNode[] = [
      { id: 'old', type: 'folder', name: '예전 폴더', parent_id: null, created_at: CREATED_AT },
    ];
    expect(moveTargets({ nodes, movingIds: [], section: 'note' }).map((t) => t.id)).toEqual([
      null,
      'old',
    ]);
  });

  it('파일·오답노트 노드는 대상이 되지 않는다(폴더만)', () => {
    const targets = moveTargets({ nodes: sampleNodes(), movingIds: ['exam-pdf'], section: 'exam' });
    expect(targets.map((target) => target.id)).toEqual([
      null,
      'term',
      'common2',
      'calculus',
      'deep',
      'mock',
    ]);
  });

  it('여럿을 옮길 때는 어느 하나의 자손이기만 해도 고를 수 없다', () => {
    const targets = moveTargets({
      nodes: sampleNodes(),
      movingIds: ['mock', 'calculus'],
      section: 'exam',
    });
    expect(row(targets, 'deep')).toMatchObject({ disabled: true, reason: '하위 폴더' });
    expect(row(targets, 'mock')).toMatchObject({ disabled: true, reason: '옮길 항목' });
    // 옮기는 둘의 부모가 서로 다르므로(학기 / 최상위) 제자리 이동이 아니다.
    expect(row(targets, 'term')?.disabled).toBe(false);
    expect(row(targets, null)?.disabled).toBe(false);
  });

  it('이미 전부 최상위에 있으면 최상위를 고를 수 없다', () => {
    const targets = moveTargets({
      nodes: sampleNodes(),
      movingIds: ['term', 'mock'],
      section: 'exam',
    });
    expect(row(targets, null)).toMatchObject({ disabled: true, reason: '현재 위치' });
  });

  it('들여쓰기 단계는 폴더 계층을 따른다', () => {
    const targets = moveTargets({ nodes: sampleNodes(), movingIds: ['exam-pdf'], section: 'exam' });
    expect(targets.map((target) => [target.id, target.depth])).toEqual([
      [null, 0],
      ['term', 0],
      ['common2', 1],
      ['calculus', 1],
      ['deep', 2],
      ['mock', 0],
    ]);
  });
});
