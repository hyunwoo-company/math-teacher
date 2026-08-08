import { describe, expect, it } from 'vitest';
import { toPlainText } from '@/lib/to-plain-text';

describe('toPlainText - 수식 유니코드 변환', () => {
  it('위첨자를 유니코드로 바꾼다', () => {
    expect(toPlainText('$x^2$')).toBe('x²');
    expect(toPlainText('$x^{n+1}$')).toBe('xⁿ⁺¹');
    expect(toPlainText('$10^{-3}$')).toBe('10⁻³');
  });

  it('유니코드 위첨자가 없는 경우 ^(...) 로 폴백한다', () => {
    // q 는 유니코드 위첨자가 없다.
    expect(toPlainText('$x^{pq}$')).toBe('x^(pq)');
  });

  it('아래첨자를 유니코드로 바꾼다', () => {
    expect(toPlainText('$a_n$')).toBe('aₙ');
    expect(toPlainText('$a_1$')).toBe('a₁');
  });

  it('유니코드 아래첨자가 없는 경우 _(...) 로 폴백한다', () => {
    // b 는 유니코드 아래첨자가 없다.
    expect(toPlainText('$a_{b}$')).toBe('a_(b)');
  });

  it('분수는 (a)/(b) 로 바꾼다', () => {
    expect(toPlainText('$\\frac{a}{b}$')).toBe('(a)/(b)');
    expect(toPlainText('$\\frac{x+1}{2}$')).toBe('(x+1)/(2)');
  });

  it('제곱근은 √(...) 로 바꾼다', () => {
    expect(toPlainText('$\\sqrt{x}$')).toBe('√(x)');
    expect(toPlainText('$\\sqrt[3]{x}$')).toBe('³√(x)');
  });

  it('연산자/관계 기호를 유니코드로 바꾼다', () => {
    expect(toPlainText('$3 \\times 4 \\div 2$')).toBe('3 × 4 ÷ 2');
    expect(toPlainText('$x \\le 1$')).toBe('x ≤ 1');
    expect(toPlainText('$y \\ge 2$')).toBe('y ≥ 2');
    expect(toPlainText('$z \\neq 3$')).toBe('z ≠ 3');
    expect(toPlainText('$\\pm 5$')).toBe('± 5');
    expect(toPlainText('$a \\cdot b$')).toBe('a · b');
  });

  it('그리스 문자와 특수 기호를 바꾼다', () => {
    expect(toPlainText('$\\alpha + \\beta$')).toBe('α + β');
    expect(toPlainText('$\\pi$')).toBe('π');
    expect(toPlainText('$\\infty$')).toBe('∞');
    expect(toPlainText('$\\Delta = 0$')).toBe('Δ = 0');
  });

  it('알려진 함수 명령은 백슬래시만 떼어 읽히게 둔다', () => {
    expect(toPlainText('$\\sin(x)$')).toBe('sin(x)');
  });

  it('디스플레이 수식 구분자도 벗긴다', () => {
    expect(toPlainText('결과: $$\\frac{a}{b}$$')).toBe('결과: (a)/(b)');
    expect(toPlainText('값 \\(x^2\\) 끝')).toBe('값 x² 끝');
  });

  it('깨진 LaTeX 구분자를 남기지 않는다', () => {
    expect(toPlainText('설명 \\( 깨짐')).toBe('설명 깨짐');
  });
});

describe('toPlainText - 마크다운 평문화', () => {
  it('제목 기호를 제거한다', () => {
    expect(toPlainText('## 정답')).toBe('정답');
    expect(toPlainText('# 제목')).toBe('제목');
  });

  it('굵게/코드 마커를 제거한다', () => {
    expect(toPlainText('**굵게**')).toBe('굵게');
    expect(toPlainText('`code`')).toBe('code');
  });

  it('굵게가 인라인 수식을 감싸도 평문으로 만든다', () => {
    expect(toPlainText('**높이 $y$의 최댓값**')).toBe('높이 y의 최댓값');
  });

  it('순서 없는 목록은 • 로, 순서 있는 목록은 번호를 유지한다', () => {
    expect(toPlainText('- 하나\n- 둘')).toBe('• 하나\n• 둘');
    expect(toPlainText('1. 처음\n2. 다음')).toBe('1. 처음\n2. 다음');
  });

  it('제목 안의 굵게와 수식을 함께 평문화한다', () => {
    expect(toPlainText('## **4단계:** 넓이 $\\frac{1}{2}$')).toBe('4단계: 넓이 (1)/(2)');
  });

  it('여러 줄과 수식이 섞인 실제 케이스를 읽히게 만든다', () => {
    const src = '**4단계: 높이 $y$의 최댓값을 구하고 삼각형 $PAB$의 넓이를 계산합니다.**';
    expect(toPlainText(src)).toBe('4단계: 높이 y의 최댓값을 구하고 삼각형 PAB의 넓이를 계산합니다.');
  });
});
