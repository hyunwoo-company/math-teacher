/**
 * 로그인 화면 UI. 목(web-auth) 환경에서 틀린/맞는 비번 흐름을 렌더로 확인한다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccessGate } from '@/components/AccessGate';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_ACCESS_PASSWORD } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();
let previousMode: string | undefined;

beforeEach(() => {
  previousMode = process.env.NEXT_PUBLIC_MOCK_MODE;
  process.env.NEXT_PUBLIC_MOCK_MODE = 'web-auth';
  window.localStorage.clear();
  useWorkspace.setState(initial, true);
  resetMockState();
});

afterEach(() => {
  process.env.NEXT_PUBLIC_MOCK_MODE = previousMode;
  window.localStorage.clear();
  resetMockState();
});

describe('AccessGate', () => {
  it('제목과 비번 입력, 들어가기 버튼을 담백하게 보여준다', () => {
    render(<AccessGate />);
    expect(screen.getByRole('heading', { name: '수학 문제풀이' })).toBeInTheDocument();
    expect(screen.getByLabelText('접속 비밀번호')).toBeInTheDocument();
    // 비번이 비어 있으면 버튼은 비활성.
    expect(screen.getByRole('button', { name: '들어가기' })).toBeDisabled();
  });

  it('틀린 비번이면 인라인 에러를 보여준다', async () => {
    const user = userEvent.setup();
    render(<AccessGate />);

    await user.type(screen.getByLabelText('접속 비밀번호'), 'wrong');
    await user.click(screen.getByRole('button', { name: '들어가기' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('비밀번호가 올바르지 않습니다.');
    expect(useWorkspace.getState().accessOk).toBe(false);
  }, 15_000);

  it('맞는 비번이면 진입한다(accessOk=true)', async () => {
    const user = userEvent.setup();
    render(<AccessGate />);

    await user.type(screen.getByLabelText('접속 비밀번호'), MOCK_ACCESS_PASSWORD);
    await user.click(screen.getByRole('button', { name: '들어가기' }));

    await waitFor(() => expect(useWorkspace.getState().accessOk).toBe(true), { timeout: 10_000 });
    expect(screen.queryByRole('alert')).toBeNull();
  }, 15_000);
});
