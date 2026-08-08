/**
 * 풀이 캐시 회귀 테스트(목 API).
 *
 * 이미 저장 풀이가 있는(status='done') 문항은 재호출하지 않고,
 * 명시적 재풀이(force)만 다시 solve 를 호출하는지 검증한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();

function reset() {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
}

async function selectMockFile() {
  await useWorkspace.getState().loadEnv();
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
}

describe('중앙 풀이 캐시', () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it(
    '이미 done 인 문항은 재호출하지 않고, force 일 때만 다시 푼다',
    async () => {
      await selectMockFile();
      await useWorkspace.getState().startSolve([1]);
      expect(useWorkspace.getState().solutions[1]?.status).toBe('done');

      // done 상태에서 다시 풀이를 걸어도 solve 를 재호출하지 않는다.
      const spy = vi.spyOn(api, 'solve');
      await useWorkspace.getState().startSolve([1]);
      expect(spy).not.toHaveBeenCalled();
      expect(useWorkspace.getState().toast?.kind).toBe('info');

      // 명시적 "다시 풀기"(force)는 재호출한다.
      await useWorkspace.getState().startSolve([1], { force: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(useWorkspace.getState().solutions[1]?.status).toBe('done');
    },
    30_000,
  );

  it(
    '전체 풀이는 이미 풀린 문항을 건너뛰고 남은 것만 푼다',
    async () => {
      await selectMockFile();
      // 1번만 미리 풀어 done 으로 만든다.
      await useWorkspace.getState().startSolve([1]);

      const spy = vi.spyOn(api, 'solve');
      await useWorkspace.getState().startSolve(null);

      // 전체 풀이는 done(1번)을 제외한 나머지만 서버에 요청한다.
      expect(spy).toHaveBeenCalledTimes(1);
      const body = spy.mock.calls[0]?.[1];
      const requested = body?.problem_numbers ?? [];
      expect(requested).not.toContain(1);
      expect(requested.length).toBeGreaterThan(0);
    },
    60_000,
  );
});
