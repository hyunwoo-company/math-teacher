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
import { variantCacheKey } from '@/lib/variant';
import { useWorkspace, __internal, type VariantByMode } from '@/store/workspace';
import type { Job, VariantMode } from '@/types/api';

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

/**
 * 그 문항·유형이 "생성 중" 인 자리를 심는다.
 *
 * 진행 여부의 단일 소스는 이 자리다 — 개별 생성(`generateVariant`)과 일괄
 * 생성(`startVariantBatch`) 이 둘 다 실제로 이 자리를 먼저 만든다.
 */
function seedStreaming(numbers: readonly number[], modes: readonly VariantMode[] = ['number']) {
  const variants: Record<string, VariantByMode> = { ...useWorkspace.getState().variants };
  for (const no of numbers) {
    const key = variantCacheKey(MOCK_FILE_ID, no);
    const byMode: VariantByMode = { ...variants[key] };
    for (const mode of modes) {
      byMode[mode] = {
        mode,
        text: '',
        streamingText: '',
        status: 'streaming',
        usage: null,
        cost: null,
        error: null,
      };
    }
    variants[key] = byMode;
  }
  useWorkspace.setState({ variants });
}

/** 진행 중인 변형 작업 1건을 스토어에 심는다(서버 큐에서 도는 상태 재현). */
function seedVariantJob(overrides: Partial<Job> = {}) {
  const job: Job = {
    id: 'job-variant-1',
    kind: 'variant',
    node_id: MOCK_FILE_ID,
    node_name: '분문 시험지',
    status: 'running',
    total: 3,
    done_count: 1,
    current_no: 5,
    error: null,
    created_at: '2026-08-14T09:00:00+09:00',
    updated_at: '2026-08-14T09:00:00+09:00',
    ...overrides,
  };
  useWorkspace.setState({ jobs: [job] });
  return job;
}

describe('변형 진행 상태 표시', () => {
  it('변형 작업이 돌면 상단에도 진행과 [변형 중단] 이 보인다', async () => {
    const user = await openFile();
    const spy = vi.spyOn(api, 'cancelJob');
    seedVariantJob();
    seedStreaming([5, 6]);
    render(<SolutionsTab />);

    expect(await screen.findByText('변형 중… 1/3 (현재 5번)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '변형 중단' }));
    expect(spy).toHaveBeenCalledWith('job-variant-1');
  });

  it('중단을 요청한 뒤에는 "중단하는 중…" 으로 바뀐다', async () => {
    await openFile();
    seedVariantJob();
    seedStreaming([5]);
    useWorkspace.setState({ cancelingJobIds: ['job-variant-1'] });
    render(<SolutionsTab />);

    expect(await screen.findByRole('button', { name: '중단하는 중…' })).toBeDisabled();
  });

  it('문항별 개별 생성만 돌 때도(작업 목록이 아직 비어도) 진행이 보인다', async () => {
    await openFile();
    seedStreaming([3]);
    render(<SolutionsTab />);

    expect(await screen.findByText('변형 중… 0/1')).toBeInTheDocument();
    // 중단할 작업을 못 찾았으면 버튼을 내지 않는다(누를 대상이 없다).
    expect(screen.queryByRole('button', { name: '변형 중단' })).not.toBeInTheDocument();
  });

  it('진행 중인 변형이 없으면 상단에 아무 표시도 없다', async () => {
    await openFile();
    render(<SolutionsTab />);

    expect(screen.queryByText(/변형 중…/)).not.toBeInTheDocument();
  });

  it('변형 모드에서 진행 중인 문항 행에 배지가 보인다', async () => {
    const user = await openFile();
    seedStreaming([2]);
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    expect(screen.getAllByText('변형 생성 중')).toHaveLength(1);
  });
});

describe('진행 중인 유형은 다시 걸 수 없다', () => {
  it('고른 문항이 모두 그 유형으로 생성 중이면 유형·생성 버튼이 막힌다', async () => {
    const user = await openFile();
    seedStreaming([1, 2]);
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    await user.click(screen.getByLabelText('2번 변형 선택'));

    const numberButton = screen.getByRole('button', { name: '숫자' });
    expect(numberButton).toBeDisabled();
    expect(numberButton.getAttribute('title') ?? '').toContain('이미 생성 중입니다');
    expect(screen.getByRole('button', { name: '2개 문항 변형 생성' })).toBeDisabled();

    // 숫자만 돌고 있으므로 다른 유형은 걸 수 있어야 한다.
    expect(screen.getByRole('button', { name: '조건' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '전체' })).toBeEnabled();
  });

  it("'전체' 는 3종 전부 생성 중일 때만 막힌다", async () => {
    const user = await openFile();
    seedStreaming([1], ['number', 'condition', 'number_condition']);
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));

    expect(screen.getByRole('button', { name: '전체' })).toBeDisabled();
  });

  it('일부만 진행 중이면 막지 않고 몇 개가 진행 중인지 알려준다', async () => {
    const user = await openFile();
    const spy = vi.spyOn(api, 'createJob');
    seedStreaming([1]);
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    await user.click(screen.getByLabelText('2번 변형 선택'));

    expect(screen.getByText('1개는 이미 생성 중')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '숫자' })).toBeEnabled();
    // 나머지는 걸 수 있다. 겹치는 조합은 서버가 건너뛴다.
    const createButton = screen.getByRole('button', { name: '2개 문항 변형 생성' });
    expect(createButton).toBeEnabled();
    await user.click(createButton);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('문항을 고르지 않았으면 유형 버튼을 막지 않는다', async () => {
    const user = await openFile();
    seedStreaming([1, 2, 3], ['number', 'condition', 'number_condition']);
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));

    for (const label of ['숫자', '조건', '숫자+조건', '전체']) {
      expect(screen.getByRole('button', { name: label })).toBeEnabled();
    }
    expect(screen.queryByText(/이미 생성 중$/)).not.toBeInTheDocument();
  });
});

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
    // 1번은 방금 걸어 생성 중이라 이제 막힌다(force 로도 뚫지 않는다 — 아래 테스트).
    // 여기서 확인할 것은 force 값이 요청에 실리는지다.
    await user.click(screen.getByLabelText('2번 변형 선택'));
    await user.click(screen.getByLabelText('이미 만든 것도 다시 생성'));
    await user.click(screen.getByRole('button', { name: '1개 문항 변형 생성' }));
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ force: true });
  }, 30_000);

  it('"이미 만든 것도 다시 생성" 으로도 생성 중인 조합은 다시 걸 수 없다', async () => {
    // 스토어의 개별 생성 규칙과 같다: 스트리밍 중이면 force 여부와 무관하게 no-op.
    // 진행 중인 자리를 다시 걸어도 만들어질 것이 없다.
    const user = await openFile();
    seedStreaming([1]);
    render(<SolutionsTab />);

    await user.click(screen.getByRole('button', { name: '변형 만들기' }));
    await user.click(screen.getByLabelText('1번 변형 선택'));
    await user.click(screen.getByLabelText('이미 만든 것도 다시 생성'));

    expect(screen.getByRole('button', { name: '1개 문항 변형 생성' })).toBeDisabled();
  });

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
