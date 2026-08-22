/**
 * 문항 번호 칩의 **지면 표기** 표시.
 *
 * 정석 계열(`기본 문제 1-1` / `유제 1-1`)처럼 구획마다 번호가 되돌아가는 교재는
 * `label` 이 `no` 와 다르다. 칩은 그 표기를 보여 주되, 클릭·선택이 넘기는 값은
 * 여전히 `no` 여야 한다(표시만 바꾼다 — 이걸 헷갈리면 선택이 깨진다).
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CenterPanel } from '@/components/center/CenterPanel';
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

/** 파일을 열고 1·2번에만 지면 표기를 심는다(나머지는 보통 시험지 그대로). */
async function openFileWithPrintedLabels() {
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
  const detail = useWorkspace.getState().fileDetail;
  if (detail == null) throw new Error('파일 상세를 불러오지 못했습니다');
  const labels: Record<number, string> = { 1: '기본 문제 1-1', 2: '유제 1-1' };
  useWorkspace.setState({
    fileDetail: {
      ...detail,
      problems: detail.problems.map((problem) => ({
        ...problem,
        label: labels[problem.no] ?? String(problem.no),
      })),
    },
  });
}

describe('문항 번호 칩 (지면 표기)', () => {
  it('표기가 다르면 칩에 표기가 보이고, 같은 문항은 번호만 보인다', async () => {
    await openFileWithPrintedLabels();
    render(<CenterPanel />);

    const chip = screen.getByRole('button', { name: '1번 문제 (문제지 표기 기본 문제 1-1)' });
    expect(chip).toHaveTextContent('기본 문제 1-1');
    // 표기에 `번` 을 덧붙이지 않는다.
    expect(chip.textContent).not.toContain('번');
    // 표기가 번호와 같은 문항은 지금 그대로다.
    expect(screen.getByRole('button', { name: '3번 문제' })).toHaveTextContent('3');
  });

  it('전체 표기는 title 로도 볼 수 있다', async () => {
    await openFileWithPrintedLabels();
    render(<CenterPanel />);

    const chip = screen.getByRole('button', { name: '2번 문제 (문제지 표기 유제 1-1)' });
    expect(chip.getAttribute('title')).toContain('유제 1-1');
    expect(chip.getAttribute('title')).toContain('2번 문제');
  });

  it('칩을 눌러도 넘어가는 값은 표기가 아니라 `no` 다', async () => {
    const user = userEvent.setup();
    await openFileWithPrintedLabels();
    const focusProblem = vi.fn();
    useWorkspace.setState({ focusProblem });
    render(<CenterPanel />);

    await user.click(
      screen.getByRole('button', { name: '1번 문제 (문제지 표기 기본 문제 1-1)' }),
    );
    expect(focusProblem).toHaveBeenCalledWith(1);
  });

  it('담기 모드에서도 선택은 `no` 로 쌓인다', async () => {
    const user = userEvent.setup();
    await openFileWithPrintedLabels();
    render(<CenterPanel />);

    await user.click(screen.getByRole('button', { name: '오답노트에 담기' }));
    await user.click(
      screen.getByRole('button', { name: '2번 선택/해제 (문제지 표기 유제 1-1)' }),
    );

    expect(useWorkspace.getState().notePicked).toEqual([2]);
  });
});

describe('[풀이] 탭 행의 지면 표기', () => {
  it('표기를 `문제지 표기: X` 로 보여 주고 `번` 을 붙이지 않는다', async () => {
    await openFileWithPrintedLabels();
    useWorkspace.getState().setActiveTab('solutions');
    render(<CenterPanel />);

    expect(await screen.findByText('문제지 표기: 기본 문제 1-1')).toBeInTheDocument();
    expect(screen.queryByText('문제지 기본 문제 1-1번')).not.toBeInTheDocument();
  });

  it('표기가 번호와 같은 문항에는 표기 줄이 없다', async () => {
    await openFileWithPrintedLabels();
    useWorkspace.getState().setActiveTab('solutions');
    render(<CenterPanel />);

    await screen.findByText('문제지 표기: 기본 문제 1-1');
    expect(screen.queryByText('문제지 표기: 3')).not.toBeInTheDocument();
  });
});
