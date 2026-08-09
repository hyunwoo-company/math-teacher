/**
 * 문항 다중선택 + 오답노트 다중선택.
 *
 * 선택 모드에서는 번호 클릭이 대화 시작(focusProblem)이 아니라 체크 토글이다.
 * 두 동작이 섞이지 않게 모드로 가른다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CenterPanel } from '@/components/center/CenterPanel';
import { AddToNoteButton } from '@/components/center/AddToNoteButton';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';

const initial = useWorkspace.getState();

beforeEach(() => {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

async function openFile() {
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
}

describe('문항 다중선택 (CenterPanel)', () => {
  it('[여러 개 선택] 을 누르면 번호 클릭이 대화 시작이 아니라 토글이 된다', async () => {
    const user = userEvent.setup();
    await openFile();
    const focusProblem = vi.fn();
    useWorkspace.setState({ focusProblem });

    render(<CenterPanel />);
    await user.click(screen.getByRole('button', { name: '여러 개 선택' }));
    await user.click(screen.getByRole('button', { name: '2번 선택/해제' }));

    expect(focusProblem).not.toHaveBeenCalled();
    expect(screen.getByText('1개 선택됨')).toBeInTheDocument();
  });

  it('선택 모드가 아니면 번호 클릭이 종전대로 대화를 시작한다', async () => {
    const user = userEvent.setup();
    await openFile();
    const focusProblem = vi.fn();
    useWorkspace.setState({ focusProblem });

    render(<CenterPanel />);
    // 번호 줄 버튼은 정확히 "2번 문제" 다(풀이 탭 아코디언과 구분).
    await user.click(screen.getByRole('button', { name: '2번 문제' }));

    expect(focusProblem).toHaveBeenCalledWith(2);
  });

  it('고른 번호들이 담기 버튼으로 전달된다', async () => {
    const user = userEvent.setup();
    await openFile();
    render(<CenterPanel />);

    await user.click(screen.getByRole('button', { name: '여러 개 선택' }));
    for (const no of [2, 4, 7]) {
      await user.click(screen.getByRole('button', { name: `${no}번 선택/해제` }));
    }

    expect(screen.getByText('3개 선택됨')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '3개 담기' }));
    expect(await screen.findByText(/오답노트에 담기 \(2, 4, 7번\)/)).toBeInTheDocument();
  });

  it('선택이 없으면 담기 버튼이 비활성이다', async () => {
    const user = userEvent.setup();
    await openFile();
    render(<CenterPanel />);

    await user.click(screen.getByRole('button', { name: '여러 개 선택' }));
    expect(screen.getByRole('button', { name: '오답노트에 담기' })).toBeDisabled();
  });

  it('전체 선택 / 선택 해제가 동작한다', async () => {
    const user = userEvent.setup();
    await openFile();
    render(<CenterPanel />);

    await user.click(screen.getByRole('button', { name: '여러 개 선택' }));
    await user.click(screen.getByRole('button', { name: '전체 선택' }));
    expect(screen.getByText('22개 선택됨')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '선택 해제' }));
    expect(screen.getByText('0개 선택됨')).toBeInTheDocument();
  });
});

describe('오답노트 다중선택 (AddToNoteButton)', () => {
  it('노트를 여러 개 고르면 확인 버튼 라벨이 바뀌고 한 번에 담는다', async () => {
    const user = userEvent.setup();
    const addProblemsToNotes = vi.fn().mockResolvedValue(true);
    await useWorkspace.getState().loadTree();
    useWorkspace.setState({ addProblemsToNotes });

    // 노트 2개를 만들어 둔다.
    await useWorkspace.getState().createNote('이현우 오답', null);
    await useWorkspace.getState().createNote('김민지 오답', null);

    render(<AddToNoteButton sourceNodeId={MOCK_FILE_ID} problemNumbers={[2, 4]} />);
    await user.click(screen.getByRole('button', { name: '2개 담기' }));

    const first = await screen.findByRole('checkbox', { name: /이현우 오답/ });
    const second = await screen.findByRole('checkbox', { name: /김민지 오답/ });
    await user.click(first);
    await user.click(second);

    const confirm = screen.getByRole('button', { name: '2개 노트에 담기' });
    await user.click(confirm);

    await waitFor(() => expect(addProblemsToNotes).toHaveBeenCalledTimes(1));
    const [noteIds, sourceId, numbers] = addProblemsToNotes.mock.calls[0]!;
    expect(noteIds).toHaveLength(2);
    expect(sourceId).toBe(MOCK_FILE_ID);
    expect(numbers).toEqual([2, 4]);
  });

  it('노트를 하나도 고르지 않으면 확인 버튼이 비활성이다', async () => {
    const user = userEvent.setup();
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().createNote('이현우 오답', null);

    render(<AddToNoteButton sourceNodeId={MOCK_FILE_ID} problemNumbers={[1]} />);
    await user.click(screen.getByRole('button', { name: '오답노트에 담기' }));

    await screen.findByRole('checkbox', { name: /이현우 오답/ });
    expect(screen.getByRole('button', { name: '담기' })).toBeDisabled();
  });
});
