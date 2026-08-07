/**
 * 스레드 바: 스레드 목록 표시 · 클릭 전환 · 활성 강조.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThreadBar } from '@/components/ai/ThreadBar';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

function seedThreads() {
  useWorkspace.setState({
    selectedFileId: MOCK_FILE_ID,
    activeThreadNo: 6,
    threads: [
      { problem_no: null, turns: 2, updated_at: '2026-08-01T00:00:00Z' },
      { problem_no: 6, turns: 1, updated_at: '2026-08-01T00:01:00Z' },
    ],
  });
}

describe('ThreadBar', () => {
  it('전역 + 문항 스레드를 칩으로 보여주고 활성 스레드를 강조한다', () => {
    seedThreads();
    render(<ThreadBar />);
    expect(screen.getByText('전체')).toBeInTheDocument();
    expect(screen.getByText('6번')).toBeInTheDocument();
    // 활성(6번) 전환 버튼은 aria-pressed=true.
    const sixSwitch = screen.getByTitle('6번 문제 대화로 전환');
    expect(sixSwitch).toHaveAttribute('aria-pressed', 'true');
  });

  it('전역 칩을 클릭하면 전역 스레드로 전환한다', async () => {
    seedThreads();
    render(<ThreadBar />);
    fireEvent.click(screen.getByTitle('전체 대화(전역 스레드)로 전환'));
    await waitFor(() => expect(useWorkspace.getState().activeThreadNo).toBeNull());
  });

  it('선택된 파일이 없으면 아무것도 렌더하지 않는다', () => {
    const { container } = render(<ThreadBar />);
    expect(container).toBeEmptyDOMElement();
  });
});
