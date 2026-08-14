import { describe, expect, it } from 'vitest';
import {
  hasMath,
  parseBlocks,
  plainPreview,
  renderMathToHtml,
  splitInline,
  splitMath,
  stripVerification,
} from '@/lib/math-text';

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

describe('parseBlocks', () => {
  it('## 제목을 h2 헤딩으로 분류한다', () => {
    expect(parseBlocks('## 정답')).toEqual([{ kind: 'heading', level: 2, content: '정답' }]);
  });

  it('### 제목은 레벨 3', () => {
    expect(parseBlocks('### 핵심 개념')).toEqual([
      { kind: 'heading', level: 3, content: '핵심 개념' },
    ]);
  });

  it('연속된 - 항목을 하나의 ul 로 묶는다', () => {
    expect(parseBlocks('- a\n- b')).toEqual([{ kind: 'ul', items: ['a', 'b'] }]);
  });

  it('연속된 1. 항목을 하나의 ol 로 묶는다', () => {
    expect(parseBlocks('1. a\n2. b')).toEqual([{ kind: 'ol', items: ['a', 'b'] }]);
  });

  it('그 외 줄은 문단이고 연속 줄은 개행을 유지한다', () => {
    expect(parseBlocks('첫 줄\n둘째 줄')).toEqual([
      { kind: 'paragraph', content: '첫 줄\n둘째 줄' },
    ]);
  });

  it('빈 줄은 문단을 나눈다', () => {
    expect(parseBlocks('앞 문단\n\n뒤 문단')).toEqual([
      { kind: 'paragraph', content: '앞 문단' },
      { kind: 'paragraph', content: '뒤 문단' },
    ]);
  });

  it('여러 줄에 걸친 디스플레이 수식을 통째로 math 블록으로 보호한다', () => {
    expect(parseBlocks('$$\n\\frac{a}{b}\n$$')).toEqual([
      { kind: 'math', content: '$$\n\\frac{a}{b}\n$$' },
    ]);
  });

  it('제목·목록과 섞인 디스플레이 수식도 경계를 침범하지 않는다', () => {
    expect(parseBlocks('## 정답\n$$\\frac{a}{b}$$\n- 하나\n- 둘')).toEqual([
      { kind: 'heading', level: 2, content: '정답' },
      { kind: 'math', content: '$$\\frac{a}{b}$$' },
      { kind: 'ul', items: ['하나', '둘'] },
    ]);
  });

  it('닫히지 않은 디스플레이 구분자는 리터럴 문단으로 둔다', () => {
    expect(parseBlocks('$$ 열기만 함')).toEqual([{ kind: 'paragraph', content: '$$ 열기만 함' }]);
  });
});

/* ── 검산 언급 제거(표시용) ─────────────────────────────────────── */

describe('stripVerification', () => {
  describe('지운다', () => {
    it('검산했다는 문장만 남은 줄을 지운다', () => {
      expect(stripVerification('## 정답\n$x=2$\n\n검산했습니다.')).toBe('## 정답\n$x=2$');
    });

    it('검산 라벨로 시작하는 줄을 통째로 지운다', () => {
      expect(stripVerification('검산: $x=2$ 를 대입하면 성립한다. ✔')).toBe('');
    });

    it('줄 안의 검산 문장만 지우고 앞 문장은 남긴다', () => {
      expect(stripVerification('따라서 $x=2$ 이다. 검산했습니다.')).toBe('따라서 $x=2$ 이다.');
    });

    it('검산 문장을 지운 뒤 홀로 남은 ✔ 도 걷어낸다', () => {
      expect(stripVerification('답은 2이다. 검산했습니다. ✔')).toBe('답은 2이다.');
    });

    it('## 검산 섹션은 그 안의 내용까지 지운다', () => {
      expect(stripVerification('## 검산\n좌변과 우변이 같다.\n\n## 정답\n$x=2$')).toBe(
        '## 정답\n$x=2$',
      );
    });

    it('검산 섹션 안의 더 깊은 제목도 섹션에 딸려 사라진다', () => {
      expect(stripVerification('## 검산\n### 대입\n확인했다.\n\n## 정답\n2')).toBe('## 정답\n2');
    });

    it('✔ 만 있는 줄을 지운다', () => {
      expect(stripVerification('답은 2이다.\n✔')).toBe('답은 2이다.');
    });

    it('목록 항목의 검산 언급도 지운다', () => {
      expect(stripVerification('- 답: 2\n- 검산했음')).toBe('- 답: 2');
    });

    it('굵게 감싼 검산 완료 표기도 지운다', () => {
      expect(stripVerification('**검산 완료**')).toBe('');
    });

    it('짧은 도입부 뒤의 검산 완료 언급도 지운다', () => {
      expect(stripVerification('위 결과를 검산하였다.')).toBe('');
    });

    it('검산 줄만 지우고 여러 줄 디스플레이 수식은 원문 그대로 남긴다', () => {
      expect(stripVerification('값:\n$$\n\\frac{a}{b}\n$$\n검산 완료 ✔')).toBe(
        '값:\n$$\n\\frac{a}{b}\n$$',
      );
    });

    it('\\[...\\] 구분자도 원문 그대로 보존한다', () => {
      expect(stripVerification('\\[a+b\\]\n검산했습니다.')).toBe('\\[a+b\\]');
    });
  });

  describe('지우지 않는다', () => {
    it('검산이 없으면 원문을 그대로 돌려준다', () => {
      const source = '## 풀이\n1. 양변을 정리한다.\n2. $x=2$ 를 얻는다.\n\n## 정답\n$x=2$';
      expect(stripVerification(source)).toBe(source);
    });

    it('검산을 지시하는 문제 문장은 남긴다', () => {
      expect(stripVerification('다음 계산을 검산하시오.')).toBe('다음 계산을 검산하시오.');
    });

    it('검산이 주제로 쓰인 문장은 남긴다', () => {
      expect(stripVerification('검산의 정의를 서술하라.')).toBe('검산의 정의를 서술하라.');
      expect(stripVerification('검산기를 쓰면 안 된다.')).toBe('검산기를 쓰면 안 된다.');
    });

    it('앞말이 긴 문장은 실제 내용으로 보고 남긴다 (보수적으로 덜 지운다)', () => {
      const source = '정답은 $x=2$ 이며, 이는 검산했을 때에도 어긋나지 않는다.';
      expect(stripVerification(source)).toBe(source);
    });

    it('검산이 아닌 제목과 그 내용은 건드리지 않는다', () => {
      const source = '## 정답 및 채점 기준\n부분점수는 없다.';
      expect(stripVerification(source)).toBe(source);
    });

    it('본문 속 ✔ 는 그대로 둔다 (검산 문장을 지운 줄이 아니다)', () => {
      expect(stripVerification('조건 ✔ 를 만족한다.')).toBe('조건 ✔ 를 만족한다.');
    });

    it('수식 안의 문자열은 손대지 않는다', () => {
      const source = '$\\text{검산}$ 표기를 설명한다.';
      expect(stripVerification(source)).toBe(source);
    });
  });
});
