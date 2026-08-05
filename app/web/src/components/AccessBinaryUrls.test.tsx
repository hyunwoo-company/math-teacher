/**
 * 배포 인증(web-auth)에서 바이너리 URL 에 `?access=` 가 실제로 실려 DOM 까지
 * 도달하는지 확인한다. (실서버 3001 브라우저 확인의 대체 수단)
 *
 * 왜 jsdom 렌더인가: 이 저장소는 `.next` 를 공유하는 dev 서버(3000)가 떠 있는
 * 동안 같은 폴더에서 `next dev`/`build` 를 다시 돌리면 그 dev 를 깨뜨린다.
 * 그래서 별도 서버를 띄우는 대신, 이 프로젝트가 이미 쓰는 방식(Workspace.test 의
 * "브라우저 육안 확인 대신 쓰는 검증 수단")대로 실제 컴포넌트를 렌더해 확인한다.
 * pdf.js 는 jsdom 에서 canvas 를 못 그리므로 뷰어만 대역으로 바꿔 fileUrl 만 관찰한다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Workspace } from '@/components/Workspace';
import { ProblemCrop } from '@/components/center/ProblemCrop';
import { resetMockState } from '@/lib/mock/client';
import { writeStoredPassword } from '@/lib/access-gate';
import { MOCK_ACCESS_PASSWORD } from '@/lib/mock/data';
import { useWorkspace } from '@/store/workspace';

// pdf.js 는 jsdom 에서 못 돌린다. 대역으로 바꿔 넘겨받은 fileUrl 을 화면에 노출시킨다.
vi.mock('@/components/center/PdfViewer', () => ({
  PdfViewer: ({ fileUrl }: { fileUrl: string }) => (
    <div data-testid="pdf-viewer-stub">PDF 뷰어 대역: {fileUrl}</div>
  ),
}));

const initial = useWorkspace.getState();
let previousMode: string | undefined;

beforeEach(() => {
  previousMode = process.env.NEXT_PUBLIC_MOCK_MODE;
  process.env.NEXT_PUBLIC_MOCK_MODE = 'web-auth';
  window.localStorage.clear();
  useWorkspace.setState(initial, true);
  resetMockState();
});

afterEach(() => {
  process.env.NEXT_PUBLIC_MOCK_MODE = previousMode;
  window.localStorage.clear();
  resetMockState();
});

describe('web-auth 배포에서 바이너리 URL 에 ?access= 부착', () => {
  it('로그인 후 원본 PDF URL 에 ?access=<비번> 이 붙어 뷰어로 전달된다', async () => {
    const user = userEvent.setup();
    render(<Workspace />);

    // 게이트에서 접속 비번을 넣고 진입한다.
    await user.type(await screen.findByLabelText('접속 비밀번호'), MOCK_ACCESS_PASSWORD);
    await user.click(screen.getByRole('button', { name: '들어가기' }));
    await waitFor(() => expect(useWorkspace.getState().accessOk).toBe(true), { timeout: 10_000 });

    // 시험지를 연다.
    await user.click(await screen.findByRole('treeitem', { name: /공통수학1/ }, { timeout: 5000 }));
    await user.click(await screen.findByRole('treeitem', { name: /풍문고/ }, { timeout: 5000 }));

    // PDF 뷰어 대역이 받은 fileUrl 에 ?access= 가 실려 있어야 한다.
    const stub = await screen.findByTestId('pdf-viewer-stub', {}, { timeout: 5000 });
    expect(stub).toHaveTextContent(`?access=${MOCK_ACCESS_PASSWORD}`);
  }, 30_000);

  it('크롭 <img> 는 목의 data: URI 라 쿼리를 붙이지 않는다(깨짐 방지)', () => {
    // 목 크롭은 data: URI 이므로 비번이 있어도 withAccess 가 그대로 둔다.
    // (실서버 http 크롭 URL 에 ?access= 가 붙는 것은 access-gate.test 에서 확인한다.)
    writeStoredPassword(MOCK_ACCESS_PASSWORD);
    render(<ProblemCrop fileId="file-1" no={3} />);
    const img = screen.getByRole('img', { name: '3번 문제 이미지' });
    const src = img.getAttribute('src') ?? '';
    expect(src.startsWith('data:')).toBe(true);
    expect(src).not.toContain('?access=');
  });
});
