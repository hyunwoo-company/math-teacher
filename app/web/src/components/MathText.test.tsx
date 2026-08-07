/**
 * 브라우저를 직접 눈으로 볼 수 없으므로, KaTeX 가 실제로 DOM 을 만들어 내는지
 * jsdom 렌더로 확인한다. (요구사항: `\(x^2+1\)` 과 `\[\frac{a}{b}\]` 둘 다)
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MathText } from '@/components/MathText';

describe('MathText', () => {
  it('인라인 수식 \\(x^2+1\\) 을 KaTeX 로 렌더한다', () => {
    const { container } = render(<MathText>{'따라서 \\(x^2+1\\) 이다.'}</MathText>);

    const katex = container.querySelector('.katex');
    expect(katex).not.toBeNull();
    // 인라인이므로 display 래퍼가 없어야 한다.
    expect(container.querySelector('.katex-display')).toBeNull();
    // 지수 2 가 실제로 렌더되었는지 확인.
    expect(katex?.textContent).toContain('2');
    expect(container.textContent).toContain('따라서');
    expect(container.textContent).toContain('이다.');
  });

  it('디스플레이 수식 \\[\\frac{a}{b}\\] 를 KaTeX 로 렌더한다', () => {
    const { container } = render(<MathText>{'값:\n\\[\\frac{a}{b}\\]\n끝'}</MathText>);

    expect(container.querySelector('.katex-display')).not.toBeNull();
    // 분수는 분자/분모 요소를 만든다.
    expect(container.querySelector('.mfrac')).not.toBeNull();
    expect(container.textContent).toContain('값:');
  });

  it('한 문단에 인라인과 디스플레이가 섞여 있어도 둘 다 렌더한다', () => {
    const { container } = render(
      <MathText>{'판별식 \\(D = b^2-4ac\\) 는\n\\[D = -4 < 0\\]\n이다.'}</MathText>,
    );
    expect(container.querySelectorAll('.katex').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('.katex-display')).not.toBeNull();
  });

  it('굵게 표기를 강조로 렌더한다', () => {
    render(<MathText>{'**1단계.** 식을 정리한다.'}</MathText>);
    expect(screen.getByText('1단계.').tagName).toBe('STRONG');
  });

  it('수식이 없으면 원문 텍스트를 그대로 보여준다', () => {
    const { container } = render(<MathText>{'수식 없는 평범한 설명입니다.'}</MathText>);
    expect(container.textContent).toBe('수식 없는 평범한 설명입니다.');
    expect(container.querySelector('.katex')).toBeNull();
  });

  it('깨진 수식이 들어와도 렌더가 죽지 않는다', () => {
    expect(() => render(<MathText>{'\\(\\frac{\\)'}</MathText>)).not.toThrow();
  });

  it('## 제목을 h2 로 렌더한다', () => {
    const { container } = render(<MathText>{'## 정답'}</MathText>);
    const h2 = container.querySelector('h2');
    expect(h2).not.toBeNull();
    expect(h2?.textContent).toBe('정답');
  });

  it('### 제목을 h3 로 렌더한다', () => {
    const { container } = render(<MathText>{'### 핵심 개념'}</MathText>);
    const h3 = container.querySelector('h3');
    expect(h3).not.toBeNull();
    expect(h3?.textContent).toBe('핵심 개념');
  });

  it('- 목록을 ul 과 li 로 렌더한다', () => {
    const { container } = render(<MathText>{'- 하나\n- 둘'}</MathText>);
    const items = container.querySelectorAll('ul > li');
    expect(items.length).toBe(2);
    expect(items[0]?.textContent).toBe('하나');
    expect(items[1]?.textContent).toBe('둘');
  });

  it('1. 목록을 ol 과 li 로 렌더한다', () => {
    const { container } = render(<MathText>{'1. 처음\n2. 다음'}</MathText>);
    const items = container.querySelectorAll('ol > li');
    expect(items.length).toBe(2);
    expect(items[1]?.textContent).toBe('다음');
  });

  it('제목 안의 인라인 수식을 KaTeX 로 렌더한다', () => {
    const { container } = render(<MathText>{'## $x^2$ 정리'}</MathText>);
    const h2 = container.querySelector('h2');
    expect(h2).not.toBeNull();
    expect(h2?.querySelector('.katex')).not.toBeNull();
    expect(h2?.textContent).toContain('정리');
  });

  it('목록 항목 안의 굵게와 인라인 수식을 렌더한다', () => {
    const { container } = render(<MathText>{'- **핵심** \\(y=2\\)'}</MathText>);
    const li = container.querySelector('ul > li');
    expect(li).not.toBeNull();
    expect(li?.querySelector('strong')?.textContent).toBe('핵심');
    expect(li?.querySelector('.katex')).not.toBeNull();
  });

  it('제목·목록과 섞인 디스플레이 수식도 깨지지 않고 렌더한다', () => {
    const { container } = render(<MathText>{'## 정답\n$$\\frac{a}{b}$$\n- 하나\n- 둘'}</MathText>);
    expect(container.querySelector('h2')?.textContent).toBe('정답');
    expect(container.querySelector('.katex-display')).not.toBeNull();
    expect(container.querySelector('.mfrac')).not.toBeNull();
    expect(container.querySelectorAll('ul > li').length).toBe(2);
  });
});
