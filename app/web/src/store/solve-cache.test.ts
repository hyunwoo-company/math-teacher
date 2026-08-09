/**
 * 풀이 캐시 회귀 테스트(목 API).
 *
 * 이미 저장 풀이가 있는(status='done') 문항은 재호출하지 않고,
 * 명시적 재풀이(force)만 다시 solve 를 호출하는지 검증한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function selectMockFile() {
  await useWorkspace.getState().loadEnv();
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
}


/**
 * 작업이 끝날 때까지 기다린다.
 *
 * 작업 큐로 바뀐 뒤 생성 호출은 즉시 돌아오고 진행은 서버(목에서는 타이머)가
 * 이어간다. 테스트는 상태가 목표에 닿을 때까지 폴링한다.
 */
async function until(check: () => boolean, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('작업이 시간 안에 끝나지 않았습니다.');
}

describe('중앙 풀이 캐시', () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    '이미 done 인 문항은 다시 풀지 않고, force 일 때만 다시 푼다',
    async () => {
      await selectMockFile();
      await useWorkspace.getState().startSolve([1]);
      await until(() => useWorkspace.getState().solutions[1]?.status === 'done');

      // 건너뛰기 판단은 **서버**가 한다(잡 생성 시점). 프론트가 걸러 버리면
      // 다른 창에서 만든 작업에는 규칙이 적용되지 않기 때문이다.
      // 그래서 요청은 나가고, 서버가 already_solved 400 으로 되돌린다.
      const spy = vi.spyOn(api, 'createJob');
      await useWorkspace.getState().startSolve([1]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(useWorkspace.getState().toast?.kind).toBe('info');
      expect(useWorkspace.getState().toast?.message).toContain('이미');
      // 기존 풀이는 그대로 남는다.
      expect(useWorkspace.getState().solutions[1]?.status).toBe('done');

      // 명시적 "다시 풀기"(force)는 실제로 다시 푼다.
      await useWorkspace.getState().startSolve([1], { force: true });
      await until(() => useWorkspace.getState().solutions[1]?.status === 'done');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]?.[0]?.force).toBe(true);
    },
    30_000,
  );

  it(
    '전체 풀이는 이미 풀린 문항을 건너뛰고 남은 것만 푼다',
    async () => {
      await selectMockFile();
      // 1번만 미리 풀어 done 으로 만든다.
      await useWorkspace.getState().startSolve([1]);
      await until(() => useWorkspace.getState().solutions[1]?.status === 'done');

      const spy = vi.spyOn(api, 'createJob');
      await useWorkspace.getState().startSolve(null);
      expect(spy).toHaveBeenCalledTimes(1);

      // 전체 풀이 요청은 problem_numbers=null 로 나가고, 대상 선정은 서버가 한다.
      expect(spy.mock.calls[0]?.[0]?.problem_numbers).toBeNull();
      // 만들어진 작업의 total 이 이미 푼 1번을 뺀 수여야 한다.
      const created = await spy.mock.results[0]?.value;
      expect(created.job.total).toBe(MOCK_PROBLEM_COUNT - 1);
    },
    60_000,
  );
});
