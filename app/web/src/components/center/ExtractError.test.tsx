/**
 * 0문항 파일의 [풀이] 탭이 **왜** 0문항인지 말하는지.
 *
 * 사유는 서버가 판정해 한국어 문장으로 준다(`GET /api/files/{id}` 의 `extract_error`).
 * 프론트는 그 문장을 그대로 띄우기만 한다 — 스캔본인지 아닌지 여기서 다시 판정하지
 * 않는다. 그래서 이 파일이 못박는 것은 세 가지다: 문장이 오면 보인다 / 없으면 기존
 * 문구로 폴백한다 / 필드가 아예 없는 옛 백엔드에서도 깨지지 않는다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SolutionsTab } from '@/components/center/SolutionsTab';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID, MOCK_SCAN_EXTRACT_ERROR } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';
import type { FileDetail, TreeNode } from '@/types/api';

const initial = useWorkspace.getState();

/** 스캔본 파일 노드(글자 정보가 없어 mode 가 image, 문항 0). */
const SCAN_NODE: TreeNode = {
  id: MOCK_FILE_ID,
  type: 'file',
  name: '2027 강대X 시즌2 6회 문제.pdf',
  parent_id: null,
  section: 'exam',
  created_at: '2026-08-21T10:00:00+09:00',
  file: { pages: 20, problem_count: 0, mode: 'image', pua_ratio: 0 },
};

beforeEach(() => {
  __internal.resetJobSubscriptions();
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * 서버가 준 파일 상세를 스토어에 실제로 태워 화면까지 보낸다.
 * `selectFile` 을 거치므로 스토어가 새 필드를 흘리지 않는지도 함께 검사된다.
 *
 * 응답을 `unknown` 을 거쳐 넘기는 까닭: 세 번째 경우는 `extract_error` 가 **아예 없는**
 * 옛 백엔드 응답이라, 타입을 지키는 객체 리터럴로는 그 상황을 만들 수 없다.
 */
async function openWith(detail: unknown) {
  vi.spyOn(api, 'getFile').mockResolvedValue(detail as FileDetail);
  await useWorkspace.getState().selectFile(MOCK_FILE_ID);
  render(<SolutionsTab />);
  // 저장된 풀이 조회가 뒤이어 비동기로 끝난다. 그 전에는 로딩 화면이라 빈 상태가 없다.
  await waitFor(() => expect(useWorkspace.getState().solutionsStatus).not.toBe('loading'));
}

const FALLBACK = /업로드한 PDF가 시험지 형식이 아니거나/;

describe('0문항 파일의 사유 표시', () => {
  it('서버가 사유를 주면 그 문장을 그대로 보여준다', async () => {
    await openWith({ node: SCAN_NODE, problems: [], extract_error: MOCK_SCAN_EXTRACT_ERROR });

    expect(screen.getByText(MOCK_SCAN_EXTRACT_ERROR)).toBeInTheDocument();
    // 제목은 그대로다(사유는 설명이 말한다).
    expect(screen.getByText('이 파일에서 문제를 찾지 못했습니다')).toBeInTheDocument();
    // 사유가 있으면 기존 일반 문구는 자리를 비킨다(두 설명이 겹치지 않는다).
    expect(screen.queryByText(FALLBACK)).toBeNull();
    expect(screen.getByRole('button', { name: /문제 다시 추출/ })).toBeInTheDocument();
  });

  it('사유가 null 이면 기존 문구를 그대로 쓴다', async () => {
    await openWith({ node: SCAN_NODE, problems: [], extract_error: null });

    expect(screen.getByText(FALLBACK)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /문제 다시 추출/ })).toBeInTheDocument();
  });

  it('사유 필드가 아예 없는 옛 백엔드에서도 기존 문구가 보이고 화면이 깨지지 않는다', async () => {
    // 필드가 생기기 전 응답 모양. `undefined` 를 "사유 없음" 으로 다뤄야 한다.
    await openWith({ node: SCAN_NODE, problems: [] });

    expect(screen.getByText('이 파일에서 문제를 찾지 못했습니다')).toBeInTheDocument();
    expect(screen.getByText(FALLBACK)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /문제 다시 추출/ })).toBeInTheDocument();
  });
});
