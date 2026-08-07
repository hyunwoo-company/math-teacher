/**
 * 스레드 삭제 · agy 쿼터 사용량 요약 스토어 로직.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();

function reset() {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
}

async function openFile() {
  await useWorkspace.getState().loadEnv();
  await useWorkspace.getState().loadTree();
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
}

describe('스레드 삭제', () => {
  beforeEach(reset);

  it('스레드를 삭제하면 목록에서 빠지고, 활성 스레드면 메시지도 비운다', async () => {
    await openFile();
    // 전역 대화 1개 + 6번 문제 대화 1개를 만든다.
    await useWorkspace.getState().sendChat('전역 질문');
    await useWorkspace.getState().openThread(6);
    await useWorkspace.getState().sendChat('6번 질문');
    await useWorkspace.getState().loadThreads();
    expect(useWorkspace.getState().threads.some((t) => t.problem_no === 6)).toBe(true);
    expect(useWorkspace.getState().activeThreadNo).toBe(6);

    // 활성(6번) 스레드를 삭제 → 목록에서 빠지고 메시지도 비워진다.
    await useWorkspace.getState().deleteThread(6);
    expect(useWorkspace.getState().threads.some((t) => t.problem_no === 6)).toBe(false);
    expect(useWorkspace.getState().messages).toHaveLength(0);

    // 전역 스레드는 그대로 남아 있다.
    await useWorkspace.getState().loadThreads();
    expect(useWorkspace.getState().threads.some((t) => t.problem_no === null)).toBe(true);
  }, 30_000);
});

describe('agy 쿼터 사용량 요약', () => {
  beforeEach(reset);

  it('사용 전에는 0, 채팅 후에는 토큰이 누적된다', async () => {
    await openFile();

    await useWorkspace.getState().loadUsageSummary();
    expect(useWorkspace.getState().usageSummary?.windows.last_7_days.tokens).toBe(0);

    await useWorkspace.getState().sendChat('질문');
    // sendChat 이 끝나며 요약을 갱신한다.
    await useWorkspace.getState().loadUsageSummary();
    const summary = useWorkspace.getState().usageSummary;
    expect(summary).not.toBeNull();
    expect(summary!.windows.last_7_days.tokens).toBeGreaterThan(0);
  }, 30_000);
});
