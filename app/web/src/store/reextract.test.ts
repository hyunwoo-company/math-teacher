/**
 * 재추출 스토어 액션: 성공/실패 시 상태와 토스트를 확인한다.
 * 목 클라이언트는 같은 원본을 다시 읽는 셈이라 문항은 그대로고 풀이만 지운다.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { api } from '@/lib/api';
import { useWorkspace } from '@/store/workspace';

beforeEach(() => {
  resetMockState();
  window.localStorage.clear();
  useWorkspace.setState({ reextracting: null, toast: null });
  vi.restoreAllMocks();
});

describe('workspace.reextractFile', () => {
  it('성공하면 문항을 갱신하고 성공 토스트를 낸다', async () => {
    await useWorkspace.getState().selectFile(MOCK_FILE_ID);
    await useWorkspace.getState().reextractFile(MOCK_FILE_ID);

    const state = useWorkspace.getState();
    expect(state.reextracting).toBeNull();
    expect(state.fileDetail?.problems.length).toBeGreaterThan(0);
    expect(state.toast?.kind).toBe('success');
    expect(state.toast?.message).toContain('다시 추출했습니다');
  });

  it('진행 중에는 중복 호출을 무시한다', async () => {
    const spy = vi.spyOn(api, 'reextractFile');
    useWorkspace.setState({ reextracting: MOCK_FILE_ID });

    await useWorkspace.getState().reextractFile(MOCK_FILE_ID);

    expect(spy).not.toHaveBeenCalled();
  });

  it('실패하면 오류 토스트를 내고 진행 상태를 푼다', async () => {
    vi.spyOn(api, 'reextractFile').mockRejectedValue(new Error('서버 오류'));

    await useWorkspace.getState().reextractFile(MOCK_FILE_ID);

    const state = useWorkspace.getState();
    expect(state.reextracting).toBeNull();
    expect(state.pendingOp).toBeNull();
    expect(state.toast?.kind).toBe('error');
  });

  it('문항을 못 찾으면 extract_error 를 오류로 알린다', async () => {
    vi.spyOn(api, 'reextractFile').mockResolvedValue({
      node: useWorkspace.getState().nodes.find((n) => n.id === MOCK_FILE_ID)!,
      problems: [],
      extract_error: '문제 번호 앵커를 찾지 못했습니다.',
      deleted_solutions: 0,
    });

    await useWorkspace.getState().reextractFile(MOCK_FILE_ID);

    const { toast } = useWorkspace.getState();
    expect(toast?.kind).toBe('error');
    expect(toast?.message).toContain('앵커');
  });
});
