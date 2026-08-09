/**
 * 작업 큐 전환의 핵심 성질 검증.
 *
 * 예전에는 풀이 스트림이 곧 HTTP 응답이라 다른 시험지로 옮기면 `abortSolve` 가
 * 걸려 작업이 끊겼다. 이제 작업은 서버 큐에서 돌고, 화면 이동은 구독만 바꾼다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_PROBLEM_COUNT } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';

const initial = useWorkspace.getState();

function reset() {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
}

async function until(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('작업이 시간 안에 끝나지 않았습니다.');
}

/** 트리를 불러오고 목 시험지를 연다. */
async function openMockFile() {
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
}

describe('작업 큐 (스토어)', () => {
  beforeEach(() => {
    reset();
  });

  it('다른 시험지로 옮겨도 작업이 끊기지 않는다', async () => {
    await openMockFile();
    await useWorkspace.getState().startSolve([1, 2, 3]);

    // 다른 파일을 연다(예전에는 여기서 abortSolve 가 걸렸다).
    const other = useWorkspace
      .getState()
      .nodes.find((node) => node.type === 'file' && node.id !== MOCK_FILE_ID);
    if (other) await useWorkspace.getState().selectFile(other.id);

    // 그래도 작업은 끝까지 간다. 결과는 문항별 캐시에 들어온다.
    const key = __internal.variantKey(MOCK_FILE_ID, 3);
    await until(() => useWorkspace.getState().problemSolutions[key]?.status === 'done');
    expect(useWorkspace.getState().problemSolutions[key]?.text).toBeTruthy();
  }, 40_000);

  it('오답노트를 열어도 작업이 계속된다', async () => {
    await openMockFile();
    await useWorkspace.getState().startSolve([1, 2]);

    const note = useWorkspace
      .getState()
      .nodes.find((node) => node.section === 'note' && node.type === 'file');
    if (note) await useWorkspace.getState().selectNote(note.id);

    const key = __internal.variantKey(MOCK_FILE_ID, 2);
    await until(() => useWorkspace.getState().problemSolutions[key]?.status === 'done');
  }, 40_000);

  it('loadJobs 로 진행 중 작업을 복구한다(새로고침 시나리오)', async () => {
    await openMockFile();
    await useWorkspace.getState().startSolve(null);
    await until(() => useWorkspace.getState().jobs.length > 0);

    // 새로고침을 흉내낸다: 스토어를 비우고 목록만 다시 받는다.
    const jobId = useWorkspace.getState().jobs[0]!.id;
    useWorkspace.setState({ jobs: [] });
    await useWorkspace.getState().loadJobs();

    expect(useWorkspace.getState().jobs.some((job) => job.id === jobId)).toBe(true);
  }, 40_000);

  it('취소하면 작업이 canceled 로 끝난다', async () => {
    await openMockFile();
    await useWorkspace.getState().startSolve(null);
    await until(() => useWorkspace.getState().jobs.length > 0);

    const jobId = useWorkspace.getState().jobs[0]!.id;
    await useWorkspace.getState().cancelJob(jobId);

    await until(() =>
      useWorkspace.getState().jobs.some((job) => job.id === jobId && job.status === 'canceled'),
    );
    expect(useWorkspace.getState().solve.running).toBe(false);
    expect(useWorkspace.getState().solve.aborted).toBe(true);
  }, 40_000);

  it('전체 풀이는 서버가 고른 대상 수를 total 로 쓴다', async () => {
    await openMockFile();
    const spy = vi.spyOn(api, 'createJob');
    await useWorkspace.getState().startSolve(null);

    const created = await spy.mock.results[0]?.value;
    expect(created.job.total).toBe(MOCK_PROBLEM_COUNT);
    expect(useWorkspace.getState().solve.total).toBe(MOCK_PROBLEM_COUNT);
  }, 40_000);
});
