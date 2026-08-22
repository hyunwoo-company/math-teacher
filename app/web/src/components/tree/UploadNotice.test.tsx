/**
 * 업로드 영역 안내 문구.
 *
 * 번호가 구획마다 1부터 다시 시작하는 교재는 프로그램이 구획을 감지하지 않는다 —
 * 사용자가 범위를 나눠 올리는 것이 전제이므로, 그 사실이 업로드 자리에 적혀
 * 있어야 한다(규칙만이 아니라 왜 그래야 하는지까지).
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/components/Workspace';
import { resetMockState } from '@/lib/mock/client';
import { UPLOAD_NOTICE, UPLOAD_SPLIT_NOTICE } from '@/lib/upload-notice';
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

describe('업로드 안내', () => {
  it('시험지 탭 업로드 영역에 두 안내가 함께 보인다', async () => {
    render(<Workspace />);
    await screen.findByText('2026-1학기', {}, { timeout: 5000 });

    expect(screen.getByText(UPLOAD_NOTICE)).toBeInTheDocument();
    expect(screen.getByText(UPLOAD_SPLIT_NOTICE)).toBeInTheDocument();
  });

  it('나눠 올리라는 이유(놓칠 수 있다)가 문구에 들어 있다', () => {
    expect(UPLOAD_SPLIT_NOTICE).toContain('나눠 올려');
    expect(UPLOAD_SPLIT_NOTICE).toContain('놓칠 수 있습니다');
  });
});
