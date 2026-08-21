/**
 * 목(web-auth) 화면의 바이너리 URL 에 **자격증명이 실리지 않는지** 확인한다.
 *
 * 예전에는 여기서 `?access=<비번>` 이 DOM 까지 도달하는지를 봤다. 지금은 비번을
 * URL 에 싣지 않으므로(→ lib/download-token 의 단기 토큰), 목의 바이너리 소스가
 * 애초에 게이트를 지나지 않는 것들(프론트 정적 자산 · `data:` URI)임을 못박아 둔다.
 * 실서버 클라이언트에서 `?token=` 이 DOM 까지 가는지는 BinaryTokenUrls.test 가 본다.
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

describe('web-auth 목에서 바이너리 URL 에 자격증명이 실리지 않는다', () => {
  it('로그인 후 원본 PDF URL 이 비번 없이 뷰어로 전달된다', async () => {
    const user = userEvent.setup();
    render(<Workspace />);

    // 게이트에서 접속 비번을 넣고 진입한다.
    await user.type(await screen.findByLabelText('접속 비밀번호'), MOCK_ACCESS_PASSWORD);
    await user.click(screen.getByRole('button', { name: '들어가기' }));
    await waitFor(() => expect(useWorkspace.getState().accessOk).toBe(true), { timeout: 10_000 });

    // 시험지를 연다. 폴더는 접힌 채로 시작하므로 루트부터 한 단계씩 편다.
    await user.click(await screen.findByRole('treeitem', { name: /2026-1학기/ }, { timeout: 5000 }));
    await user.click(await screen.findByRole('treeitem', { name: /공통수학1/ }, { timeout: 5000 }));
    await user.click(await screen.findByRole('treeitem', { name: /풍문고/ }, { timeout: 5000 }));

    // 목의 원본 PDF 는 프론트가 서빙하는 정적 자산이라 게이트를 지나지 않는다.
    // 무엇보다 비밀번호가 URL 로 새면 안 된다(전환의 목적).
    const stub = await screen.findByTestId('pdf-viewer-stub', {}, { timeout: 5000 });
    expect(stub).toHaveTextContent('/mock/sample.pdf');
    expect(stub.textContent ?? '').not.toContain('access=');
    expect(stub.textContent ?? '').not.toContain(MOCK_ACCESS_PASSWORD);
  }, 30_000);

  it('크롭 <img> 는 목의 data: URI 라 쿼리를 붙이지 않는다(깨짐 방지)', () => {
    // data: URI 는 네트워크 요청이 없으니 인증할 것도 없다. 비번이 저장돼 있어도
    // 토큰 발급을 기다리지 않고 첫 렌더에 그대로 그려야 한다(로컬/목 흐름 보존).
    writeStoredPassword(MOCK_ACCESS_PASSWORD);
    render(<ProblemCrop fileId="file-1" no={3} />);
    const img = screen.getByRole('img', { name: '3번 문제 이미지' });
    const src = img.getAttribute('src') ?? '';
    expect(src.startsWith('data:')).toBe(true);
    expect(src).not.toContain('access=');
    expect(src).not.toContain('token=');
  });
});
