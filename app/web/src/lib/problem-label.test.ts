import { describe, expect, it } from 'vitest';
import { printedLabel, printedLabelSuffix, problemChipText } from '@/lib/problem-label';

describe('printedLabel', () => {
  it('보통 시험지(표기가 번호와 같음)는 보여줄 표기가 없다', () => {
    expect(printedLabel(1, '1')).toBeNull();
    expect(printedLabel(12, '12')).toBeNull();
  });

  it('표기가 없거나 공백뿐이면 없는 것으로 본다', () => {
    expect(printedLabel(1, '')).toBeNull();
    expect(printedLabel(1, '   ')).toBeNull();
    expect(printedLabel(1, undefined)).toBeNull();
    expect(printedLabel(1, null)).toBeNull();
  });

  it('앞뒤 공백만 다른 표기도 같은 것으로 본다', () => {
    expect(printedLabel(3, ' 3 ')).toBeNull();
  });

  it('구획마다 번호가 되돌아가는 교재는 지면 표기를 그대로 보여준다', () => {
    expect(printedLabel(1, '기본 문제 1-1')).toBe('기본 문제 1-1');
    expect(printedLabel(7, '유제 2-3')).toBe('유제 2-3');
  });
});

describe('problemChipText', () => {
  it('보통 시험지는 지금과 똑같이 번호만 찍는다', () => {
    expect(problemChipText(5, '5')).toBe('5');
    expect(problemChipText(5, '')).toBe('5');
  });

  it('표기가 다르면 표기를 찍고 `번` 을 붙이지 않는다', () => {
    expect(problemChipText(1, '기본 문제 1-1')).toBe('기본 문제 1-1');
    expect(problemChipText(1, '기본 문제 1-1')).not.toContain('번');
  });
});

describe('printedLabelSuffix', () => {
  it('보여줄 표기가 없으면 빈 문자열이라 기존 문구가 그대로다', () => {
    expect(printedLabelSuffix(2, '2')).toBe('');
    expect(`${2}번 문제${printedLabelSuffix(2, '2')}`).toBe('2번 문제');
  });

  it('표기가 다르면 꼬리로 덧붙는다(앞머리는 번호로 남는다)', () => {
    expect(`${2}번 문제${printedLabelSuffix(2, '유제 1-1')}`).toBe(
      '2번 문제 (문제지 표기 유제 1-1)',
    );
  });
});
