/**
 * "변형 문제 만들기" UI 통합 테스트(목 모드).
 *
 * 풀이 탭(SolutionsTab)과 오답노트(NoteView) 양쪽에서
 * 3개 모드 선택 -> 스트리밍 결과 표시 -> 복사 가능까지 실제 렌더로 확인한다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SolutionsTab } from '@/components/center/SolutionsTab';
import { NoteView } from '@/components/center/NoteView';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_NOTE_ID } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';
import type { NoteItem, TreeNode } from '@/types/api';

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
  // 클립보드 접근이 없는 jsdom 에서 CopyButton 이 조용히 실패하도록 스텁을 둔다.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('풀이 탭의 변형 문제 만들기', () => {
  async function openProblemOne() {
    const user = userEvent.setup();
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    render(<SolutionsTab />);
    await user.click(await screen.findByRole('button', { name: '1번 문제 풀이 펼치기' }));
    return user;
  }

  it('컨트롤과 3개 모드 버튼이 보인다', async () => {
    await openProblemOne();
    expect(screen.getByText('변형 문제 만들기')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '숫자 변형' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '조건 변형' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '숫자·조건 변형' })).toBeInTheDocument();
  }, 30_000);

  it('3개 모드를 차례로 생성하면 결과가 스트리밍되고 각각 복사 버튼이 붙는다', async () => {
    const user = await openProblemOne();
    const key = __internal.variantKey(MOCK_FILE_ID, 1);

    for (const [index, label] of ['숫자 변형', '조건 변형', '숫자·조건 변형'].entries()) {
      await user.click(screen.getByRole('button', { name: label }));
      await waitFor(
        () => {
          const list = useWorkspace.getState().variants[key] ?? [];
          expect(list).toHaveLength(index + 1);
          expect(list[index]?.status).toBe('done');
        },
        { timeout: 20_000 },
      );
    }

    // 3개 결과 모두 화면에 렌더되고(계약 마크다운의 '정답' 헤딩), 원문 복사 버튼이 있다.
    expect(screen.getAllByText('정답')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: '복사' })).toHaveLength(3);
    // KaTeX 수식이 실제로 렌더됐다.
    expect(document.querySelector('.katex')).not.toBeNull();
  }, 60_000);
});

describe('오답노트의 변형 문제 만들기', () => {
  it('원본이 살아 있는 항목에서 변형을 생성하고 복사할 수 있다', async () => {
    const user = userEvent.setup();
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree('note');
    await useWorkspace.getState().selectNote(MOCK_NOTE_ID);
    await useWorkspace.getState().addProblemsToNote(MOCK_NOTE_ID, MOCK_FILE_ID, [3]);

    render(<NoteView />);
    expect(await screen.findByText('3번')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '조건 변형' }));

    const key = __internal.variantKey(MOCK_FILE_ID, 3);
    await waitFor(
      () => expect(useWorkspace.getState().variants[key]?.[0]?.status).toBe('done'),
      { timeout: 20_000 },
    );

    expect(screen.getByText('정답')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '복사' })).toBeInTheDocument();
  }, 45_000);

  it('원본이 삭제된 항목에는 변형 컨트롤을 숨긴다', () => {
    const node: TreeNode = {
      id: MOCK_NOTE_ID,
      type: 'file',
      name: '중간고사 오답',
      parent_id: null,
      section: 'note',
      created_at: new Date().toISOString(),
      file: null,
    };
    const orphan: NoteItem = {
      id: 'item-orphan',
      source_node_id: null,
      source_name: '삭제된 시험지',
      problem_no: 5,
      crop_url: '',
      memo: null,
      created_at: new Date().toISOString(),
      source_available: false,
    };
    useWorkspace.setState({
      openKind: 'note',
      selectedNoteId: MOCK_NOTE_ID,
      noteStatus: 'ready',
      noteDetail: { node, items: [orphan] },
    });

    render(<NoteView />);
    expect(screen.getByText('5번')).toBeInTheDocument();
    expect(screen.getByText('원본 삭제됨')).toBeInTheDocument();
    expect(screen.queryByText('변형 문제 만들기')).toBeNull();
  });
});
