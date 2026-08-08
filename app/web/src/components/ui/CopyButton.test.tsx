/**
 * 복사 버튼: 클립보드에 원문을 넣고 "복사됨" 피드백을 보여준다.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '@/components/ui/CopyButton';
import { toPlainText } from '@/lib/to-plain-text';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CopyButton', () => {
  it('클릭하면 넘긴 텍스트를 복사하고 복사됨을 표시한다', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<CopyButton text="**1단계.** 원문 마크다운" />);
    expect(screen.getByText('복사')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('**1단계.** 원문 마크다운'));
    expect(await screen.findByText('복사됨')).toBeInTheDocument();
  });

  it('클립보드 접근이 실패하면 복사됨을 표시하지 않는다', async () => {
    const writeText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText('복사됨')).toBeNull();
  });

  it('한글·워드용 버튼은 변환된 유니코드 평문을 클립보드에 넣는다', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    const source = '## **넓이** $\\frac{a}{b}$';
    const plain = toPlainText(source);
    expect(plain).toBe('넓이 (a)/(b)');

    render(<CopyButton text={plain} label="복사(한글·워드용)" title="한글·워드용 텍스트로 복사" />);
    // 라벨 텍스트가 접근성 이름이 되고, 기존 '복사' 버튼과 구분된다.
    expect(screen.queryByRole('button', { name: '복사' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '복사(한글·워드용)' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('넓이 (a)/(b)'));
  });
});
