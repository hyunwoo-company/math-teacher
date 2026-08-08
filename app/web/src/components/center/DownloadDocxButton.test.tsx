/**
 * '문제 내보내기(DOCX)' 버튼: 목 클라이언트의 더미 blob 으로 다운로드 흐름을 확인한다.
 * jsdom 에는 URL.createObjectURL 이 없으므로 대역으로 채운다.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadDocxButton } from '@/components/center/DownloadDocxButton';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';

const createObjectURL = vi.fn(() => 'blob:mock-docx');
const revokeObjectURL = vi.fn();

beforeEach(() => {
  resetMockState();
  window.localStorage.clear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', {
    value: createObjectURL,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: revokeObjectURL,
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DownloadDocxButton (목)', () => {
  it('클릭하면 목 blob 으로 다운로드를 트리거하고 파일명을 지정한다', async () => {
    const user = userEvent.setup();
    let downloadName: string | null = null;
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function click(this: HTMLAnchorElement) {
        downloadName = this.download;
      });

    render(<DownloadDocxButton fileId={MOCK_FILE_ID} fileName="[2026-1-1-M][공수1][풍문고].pdf" />);

    await user.click(screen.getByRole('button', { name: /문제 내보내기/ }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    // 서버 파일명이 없는 목이므로 <시험지명>_문제.docx (뒤 .pdf 제거) 로 폴백한다.
    expect(downloadName).toBe('[2026-1-1-M][공수1][풍문고]_문제.docx');
  });
});
