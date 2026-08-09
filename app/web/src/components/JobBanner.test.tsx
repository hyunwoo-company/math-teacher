/**
 * 전역 작업 배너.
 *
 * 풀이·변형은 서버 큐에서 도므로 어느 화면에 있든 진행 상황이 보여야 한다.
 * 진행 중 작업이 없으면 배너 자체가 없다.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JobBanner } from '@/components/JobBanner';
import { resetMockState } from '@/lib/mock/client';
import { useWorkspace } from '@/store/workspace';
import type { Job } from '@/types/api';

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    kind: 'solve',
    node_id: 'file-1',
    node_name: '풍문고 중간고사',
    status: 'running',
    total: 22,
    done_count: 3,
    current_no: 4,
    error: null,
    created_at: '2026-08-09T10:00:00+09:00',
    updated_at: '2026-08-09T10:01:00+09:00',
    ...overrides,
  };
}

beforeEach(() => {
  resetMockState();
  window.localStorage.clear();
  useWorkspace.setState({ jobs: [] });
});

describe('JobBanner', () => {
  it('진행 중 작업이 없으면 아무것도 그리지 않는다', () => {
    const { container } = render(<JobBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('어느 시험지의 몇 번을 하는 중인지 보여준다', () => {
    useWorkspace.setState({ jobs: [job()] });
    render(<JobBanner />);

    expect(screen.getByText('풍문고 중간고사')).toBeInTheDocument();
    expect(screen.getByText(/4번 풀이 중 \(3\/22\)/)).toBeInTheDocument();
  });

  it('대기 중인 작업은 건수로 접어 보여준다', () => {
    useWorkspace.setState({
      jobs: [
        job(),
        job({ id: 'job-2', status: 'queued', node_name: '2학기 기말', kind: 'variant' }),
      ],
    });
    render(<JobBanner />);

    expect(screen.getByText(/대기 1건/)).toBeInTheDocument();
    expect(screen.getByText(/2학기 기말 변형/)).toBeInTheDocument();
  });

  it('취소를 누르면 그 작업을 취소한다', async () => {
    const user = userEvent.setup();
    const cancelJob = vi.fn();
    useWorkspace.setState({ jobs: [job()], cancelJob });

    render(<JobBanner />);
    await user.click(screen.getByRole('button', { name: '취소' }));

    expect(cancelJob).toHaveBeenCalledWith('job-1');
  });

  it('보기를 누르면 그 시험지를 연다', async () => {
    const user = userEvent.setup();
    const openNode = vi.fn();
    const setSection = vi.fn();
    useWorkspace.setState({ jobs: [job()], openNode, setSection });

    render(<JobBanner />);
    await user.click(screen.getByRole('button', { name: '보기' }));

    expect(setSection).toHaveBeenCalledWith('exam');
    expect(openNode).toHaveBeenCalledWith('file-1');
  });

  it('서버 재시작으로 끊긴 작업은 중단 안내를 보여준다', () => {
    useWorkspace.setState({ jobs: [job({ status: 'interrupted' })] });
    render(<JobBanner />);

    expect(screen.getByText(/중단됨 — 서버가 재시작되었습니다/)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '열어서 이어 하기' }),
    ).toBeInTheDocument();
  });

  it('끝난 작업만 있으면 배너를 그리지 않는다', () => {
    useWorkspace.setState({ jobs: [job({ status: 'done' })] });
    const { container } = render(<JobBanner />);
    expect(container).toBeEmptyDOMElement();
  });
});
