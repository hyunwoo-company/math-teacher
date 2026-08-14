/**
 * 트리 다중 삭제(`deleteNodes`) 스토어 액션.
 *
 * 드래그 삭제가 선택 전체를 한 번에 넘기므로, `moveNodes` 와 같은 관례를 지키는지
 * 굳힌다: 순차 호출 / 실패는 모아 토스트 1건 / 끝나고 트리 1회 새로고침.
 * (드래그 자체는 HTML5 DnD 라 jsdom 에서 검증하지 않는다 — 규칙만 여기서 본다.)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace, __internal, type ToastMessage } from '@/store/workspace';

const initial = useWorkspace.getState();

function reset() {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  // loadTree → restoreLastOpen 이 prefs 를 읽으므로 테스트 간 격리한다.
  window.localStorage.clear();
  vi.restoreAllMocks();
}

/** 토스트는 상태 한 칸을 덮어쓰므로, 구독해서 "몇 건이 떴는지"를 센다. */
function collectToasts(): { toasts: ToastMessage[]; stop: () => void } {
  const toasts: ToastMessage[] = [];
  const stop = useWorkspace.subscribe((state) => {
    if (state.toast && !toasts.includes(state.toast)) toasts.push(state.toast);
  });
  return { toasts, stop };
}

describe('트리 다중 삭제 (deleteNodes)', () => {
  beforeEach(() => {
    reset();
  });

  it('여러 노드를 지우고 트리는 한 번만 새로 고친다', async () => {
    await useWorkspace.getState().loadTree();
    const del = vi.spyOn(api, 'deleteNode');
    const getTree = vi.spyOn(api, 'getTree');

    await useWorkspace.getState().deleteNodes(['folder-calculus', 'folder-june']);

    expect(del).toHaveBeenCalledTimes(2);
    expect(getTree).toHaveBeenCalledTimes(1);

    const { nodes } = useWorkspace.getState();
    expect(nodes.find((node) => node.id === 'folder-calculus')).toBeUndefined();
    expect(nodes.find((node) => node.id === 'folder-june')).toBeUndefined();
    expect(useWorkspace.getState().pendingOp).toBeNull();
  });

  it('상위와 하위가 함께 선택되면 상위만 지운다 (하위는 어차피 함께 사라진다)', async () => {
    await useWorkspace.getState().loadTree();
    const del = vi.spyOn(api, 'deleteNode');

    await useWorkspace.getState().deleteNodes([MOCK_FILE_ID, 'folder-common1']);

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith('folder-common1');
    const { nodes } = useWorkspace.getState();
    expect(nodes.find((node) => node.id === MOCK_FILE_ID)).toBeUndefined();
    expect(nodes.find((node) => node.id === 'folder-common1')).toBeUndefined();
  });

  it('열려 있던 파일이 지워지면 화면을 닫는다', async () => {
    await useWorkspace.getState().loadTree();
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);

    await useWorkspace.getState().deleteNodes([MOCK_FILE_ID]);

    const state = useWorkspace.getState();
    expect(state.openKind).toBe('none');
    expect(state.selectedFileId).toBeNull();
    expect(state.fileDetail).toBeNull();
  });

  it('일부가 실패해도 나머지는 지우고 실패만 토스트 1건으로 알린다', async () => {
    await useWorkspace.getState().loadTree();
    const realDelete = api.deleteNode;
    vi.spyOn(api, 'deleteNode').mockImplementation(async (id: string) => {
      if (id === 'folder-calculus') throw new Error('서버 오류');
      await realDelete(id);
    });
    const { toasts, stop } = collectToasts();

    await useWorkspace.getState().deleteNodes(['folder-calculus', 'folder-june']);
    stop();

    const { nodes } = useWorkspace.getState();
    expect(nodes.find((node) => node.id === 'folder-calculus')).toBeDefined();
    expect(nodes.find((node) => node.id === 'folder-june')).toBeUndefined();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('error');
    expect(toasts[0]?.message).toContain('1개');
  });

  it('둘 이상을 지우면 성공 토스트에 개수를 밝힌다', async () => {
    await useWorkspace.getState().loadTree();
    const { toasts, stop } = collectToasts();

    await useWorkspace.getState().deleteNodes(['folder-calculus', 'folder-june']);
    stop();

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.kind).toBe('success');
    expect(toasts[0]?.message).toContain('2개');
  });

  it('빈 목록은 서버를 부르지 않는다', async () => {
    await useWorkspace.getState().loadTree();
    const del = vi.spyOn(api, 'deleteNode');
    const getTree = vi.spyOn(api, 'getTree');

    await useWorkspace.getState().deleteNodes([]);

    expect(del).not.toHaveBeenCalled();
    expect(getTree).not.toHaveBeenCalled();
  });
});
