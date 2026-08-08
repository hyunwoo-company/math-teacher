/**
 * 새로고침 복원: 마지막으로 보던 시험지/스레드를 자동으로 다시 연다.
 * + prefs 머지 저장(서로 다른 저장부가 필드를 지우지 않음) 검증.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { UI_PREFS_STORAGE } from '@/lib/config';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();

function reset() {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
}

/** 스토어만 초기화(localStorage/목 서버 상태는 유지) — 브라우저 새로고침 흉내. */
function refreshStore() {
  useWorkspace.setState(initial, true);
}

function readPrefs(): Record<string, unknown> {
  const raw = window.localStorage.getItem(UI_PREFS_STORAGE);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function waitUntil(predicate: () => boolean, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('새로고침 복원', () => {
  beforeEach(reset);

  it('마지막으로 연 파일을 새로고침 후 자동으로 다시 연다', async () => {
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    expect(readPrefs().lastFileId).toBe(MOCK_FILE_ID);

    refreshStore();
    expect(useWorkspace.getState().selectedFileId).toBeNull();

    // 부트스트랩: loadTree 가 복원을 트리거한다(void 이므로 폴링으로 기다린다).
    await useWorkspace.getState().loadTree();
    await waitUntil(() => useWorkspace.getState().selectedFileId === MOCK_FILE_ID);
    expect(useWorkspace.getState().openKind).toBe('exam');
  }, 15_000);

  it('저장된 파일이 트리에 없으면 열지 않고 stale prefs 를 정리한다', async () => {
    window.localStorage.setItem(
      UI_PREFS_STORAGE,
      JSON.stringify({ lastFileId: 'file-does-not-exist', lastThreadNo: 3 }),
    );

    await useWorkspace.getState().loadTree();
    // restore 가 존재하지 않는 파일임을 확인하고 prefs 를 비운다.
    await waitUntil(() => readPrefs().lastFileId == null);
    expect(useWorkspace.getState().selectedFileId).toBeNull();
    expect(useWorkspace.getState().openKind).toBe('none');
  }, 15_000);

  it('마지막으로 보던 대화도 새로고침 후 복원한다', async () => {
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().loadTree();
    // 전역 대화를 하나 만들고 메시지를 남긴다(목 서버에 대화가 생긴다).
    await useWorkspace.getState().sendChat('복원될 질문');
    const convId = useWorkspace.getState().activeConversationId;
    expect(convId).not.toBeNull();
    expect(readPrefs().lastConversationId).toBe(convId);

    refreshStore();
    await useWorkspace.getState().loadEnv();
    await useWorkspace.getState().bootstrapConversations();

    await waitUntil(() => useWorkspace.getState().activeConversationId === convId);
    expect(useWorkspace.getState().messages.some((m) => m.content === '복원될 질문')).toBe(true);
  }, 30_000);

  it('사용자가 이미 다른 파일을 연 상태면 복원이 덮어쓰지 않는다', async () => {
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    // prefs.lastFileId = MOCK_FILE_ID 인 상태에서, 존재하지 않는 파일을 이미 연 것처럼 만든다.
    useWorkspace.setState({ selectedFileId: 'other-open', openKind: 'exam' });
    await useWorkspace.getState().restoreLastOpen();
    // 경합 가드로 인해 그대로 유지된다.
    expect(useWorkspace.getState().selectedFileId).toBe('other-open');
  });
});

describe('prefs 머지 저장', () => {
  beforeEach(reset);

  it('lastFileId 저장이 model/effort 등 다른 prefs 를 지우지 않는다', async () => {
    await useWorkspace.getState().loadTree();
    useWorkspace.getState().setModel('claude-sonnet-5');
    useWorkspace.getState().setEffort('high');

    await useWorkspace.getState().selectFile(MOCK_FILE_ID);

    let prefs = readPrefs();
    expect(prefs.model).toBe('claude-sonnet-5');
    expect(prefs.effort).toBe('high');
    expect(prefs.lastFileId).toBe(MOCK_FILE_ID);

    // 반대로, 파일을 연 뒤 model 을 바꿔도 lastFileId 가 살아 있다.
    useWorkspace.getState().setModel('claude-haiku-4-5');
    prefs = readPrefs();
    expect(prefs.model).toBe('claude-haiku-4-5');
    expect(prefs.lastFileId).toBe(MOCK_FILE_ID);
  });
});
