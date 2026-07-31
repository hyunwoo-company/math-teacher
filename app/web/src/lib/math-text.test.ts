import { describe, expect, it } from 'vitest';
import { hasMath, plainPreview, renderMathToHtml, splitInline, splitMath } from '@/lib/math-text';

describe('splitMath', () => {
  it('인라인 \\(...\\) 을 수식으로 분리한다', () => {
    expect(splitMath('따라서 \\(x^2+1\\) 은 양수다.')).toEqual([
      { kind: 'text', value: '따라서 ' },
      { kind: 'math', value: 'x^2+1', display: false },
      { kind: 'text', value: ' 은 양수다.' },
    ]);
  });

  it('디스플레이 \\[...\\] 를 수식으로 분리한다', () => {
    expect(splitMath('결과:\n\\[\\frac{a}{b}\\]\n끝')).toEqual([
      { kind: 'text', value: '결과:\n' },
      { kind: 'math', value: '\\frac{a}{b}', display: true },
      { kind: 'text', value: '\n끝' },
    ]);
  });

  it('$...$ 와 $$...$$ 도 지원한다', () => {
    expect(splitMath('$a+b$ 그리고 $$c+d$$')).toEqual([
      { kind: 'math', value: 'a+b', display: false },
      { kind: 'text', value: ' 그리고 ' },
      { kind: 'math', value: 'c+d', display: true },
    ]);
  });

  it('닫히지 않은 구분자는 수식으로 보지 않는다', () => {
    expect(splitMath('가격은 100$ 입니다')).toEqual([{ kind: 'text', value: '가격은 100$ 입니다' }]);
  });

  it('이스케이프된 달러는 리터럴로 남긴다', () => {
    expect(splitMath('\\$5 와 \\$7')).toEqual([{ kind: 'text', value: '$5 와 $7' }]);
  });

  it('빈 줄을 포함한 구간은 수식으로 보지 않는다', () => {
    const segments = splitMath('$문장\n\n다른 문단$');
    expect(segments.every((segment) => segment.kind === 'text')).toBe(true);
  });

  it('수식 포함 여부를 알려준다', () => {
    expect(hasMath('그냥 텍스트')).toBe(false);
    expect(hasMath('\\(x\\)')).toBe(true);
  });
});

describe('renderMathToHtml', () => {
  it('KaTeX HTML 을 만든다', () => {
    const html = renderMathToHtml('x^2+1', false);
    expect(html).toContain('katex');
    // 지수가 별도 요소로 렌더된다.
    expect(html).toContain('<span');
  });

  it('디스플레이 모드는 katex-display 를 붙인다', () => {
    expect(renderMathToHtml('\\frac{a}{b}', true)).toContain('katex-display');
  });

  it('잘못된 수식이어도 예외를 던지지 않는다', () => {
    expect(() => renderMathToHtml('\\frac{', false)).not.toThrow();
  });
});

describe('plainPreview', () => {
  it('목록 미리보기에서 마크다운/수식 기호를 걷어낸다', () => {
    expect(plainPreview('**1단계.** \\(x^2+1\\) 을 정리한다.\n둘째 줄')).toBe(
      '1단계. x^2+1 을 정리한다.',
    );
  });

  it('빈 줄을 건너뛰고 첫 내용 줄을 쓴다', () => {
    expect(plainPreview('\n\n  실제 첫 줄  \n다음')).toBe('실제 첫 줄');
  });

  it('내용이 없으면 빈 문자열을 준다', () => {
    expect(plainPreview('\n  \n')).toBe('');
  });
});

describe('splitInline', () => {
  it('굵게와 인라인 코드를 분리한다', () => {
    expect(splitInline('**1단계.** `code` 끝')).toEqual([
      { kind: 'bold', value: '1단계.' },
      { kind: 'plain', value: ' ' },
      { kind: 'code', value: 'code' },
      { kind: 'plain', value: ' 끝' },
    ]);
  });

  it('마크업이 없으면 그대로 둔다', () => {
    expect(splitInline('평범한 문장')).toEqual([{ kind: 'plain', value: '평범한 문장' }]);
  });
});
