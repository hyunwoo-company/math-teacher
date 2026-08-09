/**
 * '문제 다시 추출' 버튼: 확인 다이얼로그를 거쳐야만 재추출이 실행되고,
 * 저장된 풀이가 있으면 삭제 경고가 뜨는지 확인한다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReextractButton } from '@/components/center/ReextractButton';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

beforeEach(() => {
  resetMockState();
  window.localStorage.clear();
  useWorkspace.setState({ reextracting: null, solutions: {} });
});

describe('ReextractButton', () => {
  it('확인하기 전에는 재추출하지 않는다', async () => {
    const user = userEvent.setup();
    const reextractFile = vi.fn();
    useWorkspace.setState({ reextractFile });

    render(<ReextractButton fileId={MOCK_FILE_ID} problemCount={22} />);
    await user.click(screen.getByRole('button', { name: /문제 다시 추출/ }));

    expect(reextractFile).not.toHaveBeenCalled();
    expect(screen.getByText(/AI 를 호출하지 않습니다/)).toBeInTheDocument();
  });

  it('확인하면 그 파일 id 로 재추출한다', async () => {
    const user = userEvent.setup();
    const reextractFile = vi.fn();
    useWorkspace.setState({ reextractFile });

    render(<ReextractButton fileId={MOCK_FILE_ID} problemCount={22} />);
    await user.click(screen.getByRole('button', { name: /문제 다시 추출/ }));
    await user.click(screen.getByRole('button', { name: '다시 추출' }));

    await waitFor(() => expect(reextractFile).toHaveBeenCalledWith(MOCK_FILE_ID));
  });

  it('저장된 풀이가 있으면 삭제 건수를 경고한다', async () => {
    const user = userEvent.setup();
    useWorkspace.setState({
      reextractFile: vi.fn(),
      solutions: {
        1: { no: 1, text: 'a', streamingText: '', status: 'done', usage: null, cost: null, truncated: false, error: null, createdAt: null },
        2: { no: 2, text: 'b', streamingText: '', status: 'done', usage: null, cost: null, truncated: false, error: null, createdAt: null },
        3: { no: 3, text: '', streamingText: '', status: 'empty', usage: null, cost: null, truncated: false, error: null, createdAt: null },
      },
    });

    render(<ReextractButton fileId={MOCK_FILE_ID} problemCount={22} />);
    await user.click(screen.getByRole('button', { name: /문제 다시 추출/ }));

    // done 인 2건만 센다(empty 는 제외).
    expect(screen.getByText(/풀이 2건이 삭제됩니다/)).toBeInTheDocument();
  });

  it('풀이가 없으면 삭제 경고를 띄우지 않는다', async () => {
    const user = userEvent.setup();
    useWorkspace.setState({ reextractFile: vi.fn(), solutions: {} });

    render(<ReextractButton fileId={MOCK_FILE_ID} problemCount={0} />);
    await user.click(screen.getByRole('button', { name: /문제 다시 추출/ }));

    expect(screen.queryByText(/삭제됩니다/)).not.toBeInTheDocument();
    // 오답노트는 남는다는 안내는 항상 보인다.
    expect(screen.getByText(/오답노트에 담은 문항은 그대로 남습니다/)).toBeInTheDocument();
  });

  it('재추출 중이면 버튼이 비활성이고 진행 표시를 낸다', () => {
    useWorkspace.setState({ reextracting: MOCK_FILE_ID });
    render(<ReextractButton fileId={MOCK_FILE_ID} problemCount={22} />);

    const button = screen.getByRole('button', { name: /추출 중/ });
    expect(button).toBeDisabled();
  });
});
