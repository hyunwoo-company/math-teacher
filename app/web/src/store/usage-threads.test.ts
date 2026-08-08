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

describe('대화 삭제', () => {
  beforeEach(reset);

  it('대화를 삭제하면 목록에서 빠지고, 활성 대화면 최신으로 폴백한다', async () => {
    await openFile();
    // 대화 2개를 만든다.
    await useWorkspace.getState().sendChat('첫 대화');
    const first = useWorkspace.getState().activeConversationId;
    useWorkspace.getState().newConversation();
    await useWorkspace.getState().sendChat('둘째 대화');
    const second = useWorkspace.getState().activeConversationId;

    await useWorkspace.getState().loadConversations();
    expect(useWorkspace.getState().conversations.length).toBe(2);

    // 활성(둘째) 대화 삭제 → 목록에서 빠지고 최신(첫)으로 폴백된다.
    await useWorkspace.getState().deleteConversation(second ?? '');
    expect(useWorkspace.getState().conversations.some((c) => c.id === second)).toBe(false);
    expect(useWorkspace.getState().activeConversationId).toBe(first);
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
