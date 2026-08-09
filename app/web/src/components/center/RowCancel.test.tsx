/**
 * 풀이 탭 각 문항의 진행 표시와 중단.
 *
 * "이 문제만 풀기" 를 누른 자리에서 진행과 중단이 보여야 한다.
 * 중단은 그 문항을 담고 있는 작업을 취소한다 — 전체 풀이 작업이면 그 작업
 * 전체가 멈추므로 버튼 문구로 구분한다.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SolutionsTab } from '@/components/center/SolutionsTab';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';
import type { Job } from '@/types/api';
import type { SolutionEntry } from '@/store/workspace';

const initial = useWorkspace.getState();

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    kind: 'solve',
    node_id: MOCK_FILE_ID,
    node_name: '풍문고',
    status: 'running',
    total: 1,
    done_count: 0,
    current_no: 1,
    error: null,
    created_at: '2026-08-10T10:00:00+09:00',
    updated_at: '2026-08-10T10:00:00+09:00',
    ...overrides,
  };
}

/** 1번 문항만 '풀이 중' 인 상태를 만든다. */
function runningOnFirst(): Record<number, SolutionEntry> {
  return {
    1: {
      no: 1,
      text: '',
      streamingText: '',
      status: 'running',
      usage: null,
      cost: null,
      truncated: false,
      error: null,
      createdAt: null,
    },
  };
}

beforeEach(() => {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

async function openFileAndExpandFirst() {
  const user = userEvent.setup();
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
  // selectFile 은 저장 풀이/변형을 뒤이어 비동기로 채운다. 그게 끝난 뒤에
  // 테스트 상태를 덮어써야 덮어쓰기 경합이 없다.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return user;
}

describe('문항별 진행 표시와 중단', () => {
  it('풀이 중이면 "풀이 중…" 과 중단 버튼이 그 문항에 보인다', async () => {
    const user = await openFileAndExpandFirst();
    useWorkspace.setState({ solutions: runningOnFirst(), jobs: [job()] });

    render(<SolutionsTab />);
    await user.click(screen.getByRole('button', { name: '1번 문제 풀이 펼치기' }));

    // 목록 미리보기와 펼친 본문 두 곳에 나온다.
    expect(screen.getAllByText('풀이 중…').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '풀이 중단' })).toBeInTheDocument();
  });

  it('중단을 누르면 그 문항을 담은 작업을 취소한다', async () => {
    const user = await openFileAndExpandFirst();
    const cancelJob = vi.fn();
    useWorkspace.setState({ solutions: runningOnFirst(), jobs: [job()], cancelJob });

    render(<SolutionsTab />);
    await user.click(screen.getByRole('button', { name: '1번 문제 풀이 펼치기' }));
    await user.click(screen.getByRole('button', { name: '풀이 중단' }));

    expect(cancelJob).toHaveBeenCalledWith('job-1');
  });

  it('전체 풀이 작업이면 문구로 알린다', async () => {
    const user = await openFileAndExpandFirst();
    useWorkspace.setState({
      solutions: runningOnFirst(),
      jobs: [job({ total: 22 })],
    });

    render(<SolutionsTab />);
    await user.click(screen.getByRole('button', { name: '1번 문제 풀이 펼치기' }));

    const button = screen.getByRole('button', { name: '전체 풀이 중단' });
    expect(button).toHaveAttribute(
      'title',
      '이 시험지의 풀이 작업(22문항) 전체가 중단됩니다',
    );
  });

  it('중단을 요청한 뒤에는 "중단하는 중…" 으로 바뀌고 비활성이다', async () => {
    const user = await openFileAndExpandFirst();
    useWorkspace.setState({
      solutions: runningOnFirst(),
      jobs: [job()],
      cancelingJobIds: ['job-1'],
    });

    render(<SolutionsTab />);
    await user.click(screen.getByRole('button', { name: '1번 문제 풀이 펼치기' }));

    expect(screen.getByRole('button', { name: '중단하는 중…' })).toBeDisabled();
  });

  it('진행 중이 아닌 문항은 "이 문제만 풀기" 를 그대로 보여준다', async () => {
    const user = await openFileAndExpandFirst();
    useWorkspace.setState({ solutions: runningOnFirst(), jobs: [job()] });

    render(<SolutionsTab />);
    await user.click(screen.getByRole('button', { name: '2번 문제 풀이 펼치기' }));

    // 다른 문항이 풀리는 중이어도 이 버튼은 눌릴 수 있다(큐가 순서대로 처리).
    const button = screen.getByRole('button', { name: '이 문제만 풀기' });
    expect(button).toBeEnabled();
  });
});
