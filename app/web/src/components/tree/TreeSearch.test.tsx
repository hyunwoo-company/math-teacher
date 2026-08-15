/**
 * 좌측 트리 이름 검색 배선 확인 (목 모드).
 *
 * 판정 규칙 자체는 순수 함수(`matchNodeIds`·`splitHighlight`) 테스트가 지킨다.
 * 여기서는 배선만 본다: 입력하면 비일치 노드가 사라지는지, 접혀 있던 폴더가
 * 결과를 보여 주려고 펼쳐지는지, 검색어를 지우면 이전 상태로 돌아오는지.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/components/Workspace';
import { resetMockState } from '@/lib/mock/client';
import { useWorkspace } from '@/store/workspace';

vi.mock('@/components/center/PdfViewer', () => ({
  PdfViewer: ({ fileUrl }: { fileUrl: string }) => (
    <div data-testid="pdf-viewer-stub">PDF 뷰어 대역: {fileUrl}</div>
  ),
}));

const initial = useWorkspace.getState();

beforeEach(() => {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
});

async function openWorkspace() {
  const user = userEvent.setup();
  render(<Workspace />);
  await screen.findByText('2026-1학기', {}, { timeout: 5000 });
  return user;
}

describe('좌측 트리 이름 검색', () => {
  it('입력하면 비일치 노드가 사라지고, 일치한 곳까지 펼쳐 보여 준다', async () => {
    const user = await openWorkspace();
    // 처음에는 루트만 펼쳐져 있어 파일 행이 보이지 않는다.
    expect(screen.queryByRole('treeitem', { name: /풍문고/ })).toBeNull();

    await user.type(screen.getByRole('searchbox', { name: '시험지 이름 검색' }), '풍문');

    // 일치한 파일 + 조상 폴더만 남는다.
    expect(await screen.findByRole('treeitem', { name: /풍문고/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /공통수학1/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /2026-1학기/ })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /모의고사/ })).toBeNull();
      expect(screen.queryByRole('treeitem', { name: /미적분/ })).toBeNull();
    });

    // 일치한 부분만 강조한다.
    expect(screen.getByText('풍문').tagName).toBe('MARK');
  });

  it('일치가 없으면 빈 상태를 낸다', async () => {
    const user = await openWorkspace();
    await user.type(screen.getByRole('searchbox', { name: '시험지 이름 검색' }), '없는이름');
    expect(await screen.findByText('검색 결과가 없습니다')).toBeInTheDocument();
  });

  it('Esc 로 지우면 검색 이전의 펼침 상태로 돌아온다', async () => {
    const user = await openWorkspace();
    const input = screen.getByRole('searchbox', { name: '시험지 이름 검색' });

    await user.type(input, '풍문');
    expect(await screen.findByRole('treeitem', { name: /풍문고/ })).toBeInTheDocument();

    await user.type(input, '{Escape}');

    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /모의고사/ })).toBeInTheDocument();
      // 검색 때문에 펼쳐졌던 폴더는 원래대로 접혀 있어야 한다.
      expect(screen.queryByRole('treeitem', { name: /풍문고/ })).toBeNull();
    });
  });
});
