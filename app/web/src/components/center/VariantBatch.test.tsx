/**
 * [풀이] 탭의 변형 일괄 생성 UI.
 *
 * 문항을 여러 개 골라 한 번에 변형을 만든다. 담기 모드와 체크박스를 공유하되
 * 두 모드는 상호 배타라, 체크 하나가 언제나 한 가지 뜻만 갖는다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SolutionsTab } from '@/components/center/SolutionsTab';
import { api } from '@/lib/api';
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
  const user = userEvent.setup();
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
  // selectFile 이 저장 풀이·변형을 뒤이어 비동기로 채운다. 그게 끝난 뒤 시작한다.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return user;
}

describe('변형 일괄 생성 UI', () => {
  it('[변형 만들기] 를 누르면 유형 버튼과 문항 체크박스가 나온다', async () => {
    const user = await openFile();
    render(<SolutionsTab />);

    // 평소에는 체크박스가 없다.
    expect(screen.queryByLabelText('1번 변형 선택')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));

    for (const label of ['숫자', '조건', '숫자+조건', '전체']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByLabelText('1번 변형 선택')).toBeInTheDocument();
    // 고른 문항이 없으면 생성 버튼은 눌리지 않는다.
    expect(screen.getByRole('button', { name: '0개 문항 변형 생성' })).toBeDisabled();
  });

  it('고른 문항과 유형으로 작업을 만든다', async () => {
    const user = await openFile();
    const spy = vi.spyOn(api, 'createJob');
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByRole('button', { name: '숫자+조건' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    await user.click(screen.getByLabelText('3번 변형 선택'));
    await user.click(screen.getByRole('button', { name: '2개 문항 변형 생성' }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      kind: 'variant',
      node_id: MOCK_FILE_ID,
      problem_numbers: [1, 3],
      modes: ['number_condition'],
    });
    // 작업이 만들어지면 모드가 닫혀 체크박스가 사라진다(생성 요청은 비동기다).
    await waitFor(() =>
      expect(screen.queryByLabelText('1번 변형 선택')).not.toBeInTheDocument(),
    );
  });

  it('"이미 만든 것도 다시 생성" 을 켜면 force 로 건다', async () => {
    const user = await openFile();
    const spy = vi.spyOn(api, 'createJob');
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    // 기본은 꺼져 있다(이미 만든 것을 쓸데없이 다시 만들지 않는다).
    await user.click(screen.getByRole('button', { name: '1개 문항 변형 생성' }));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ force: false });

    // 생성 요청이 끝나면 모드가 닫힌다. 닫히기 전에 버튼을 다시 누르면 토글이
    // 반대로 먹으므로 기다렸다가 다시 연다.
    await waitFor(() =>
      expect(screen.queryByLabelText('1번 변형 선택')).not.toBeInTheDocument(),
    );
    spy.mockClear();
    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    await user.click(screen.getByLabelText('이미 만든 것도 다시 생성'));
    await user.click(screen.getByRole('button', { name: '1개 문항 변형 생성' }));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ force: true });
  }, 30_000);

  it('모드를 다시 열면 force 가 꺼진 채로 시작한다', async () => {
    const user = await openFile();
    const spy = vi.spyOn(api, 'createJob');
    render(<SolutionsTab />);

    // 한 번 켜서 걸고,
    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    await user.click(screen.getByLabelText('이미 만든 것도 다시 생성'));
    await user.click(screen.getByRole('button', { name: '1개 문항 변형 생성' }));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ force: true });

    await waitFor(() =>
      expect(screen.queryByLabelText('1번 변형 선택')).not.toBeInTheDocument(),
    );
    spy.mockClear();

    // 다시 열면 문항 선택처럼 force 도 버려져 있어야 한다. 남으면 모르고 건
    // 다음 배치가 이미 만든 것까지 통째로 재생성해 쿼터를 태운다.
    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    expect(screen.getByLabelText('이미 만든 것도 다시 생성')).not.toBeChecked();
    await user.click(screen.getByLabelText('2번 변형 선택'));
    await user.click(screen.getByRole('button', { name: '1개 문항 변형 생성' }));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ force: false });
  }, 30_000);

  it('담기 모드를 켜면 변형 모드는 꺼진다(체크박스 뜻이 하나여야 한다)', async () => {
    const user = await openFile();
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    expect(useWorkspace.getState().variantPicked).toEqual([1]);

    useWorkspace.getState().startNotePicking();

    expect(useWorkspace.getState().variantPicking).toBe(false);
    expect(useWorkspace.getState().variantPicked).toEqual([]);
    expect(await screen.findByLabelText('1번 오답노트 선택')).toBeInTheDocument();
    expect(screen.queryByLabelText('1번 변형 선택')).not.toBeInTheDocument();
  });

  it('[취소] 는 선택을 버리고 모드를 닫는다', async () => {
    const user = await openFile();
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('2번 변형 선택'));
    await user.click(screen.getByRole('button', { name: '취소' }));

    expect(useWorkspace.getState().variantPicking).toBe(false);
    expect(useWorkspace.getState().variantPicked).toEqual([]);
    expect(screen.queryByLabelText('2번 변형 선택')).not.toBeInTheDocument();
  });
});
