/**
 * 문항 번호 감지 테스트.
 *
 * 오탐(엉뚱한 문제 이미지를 첨부)이 미탐보다 나쁘므로 negative 케이스를 강하게 잠근다.
 */

import { describe, expect, it } from 'vitest';
import { detectProblemNo, detectProblemNos } from '@/lib/mention';

/** 이 시험지 = 1..22번 */
const NOS = Array.from({ length: 22 }, (_, index) => index + 1);

describe('detectProblemNos — 복수 추출', () => {
  it('여러 번호를 등장 순서대로 모두 뽑는다', () => {
    expect(detectProblemNos('5번 6번 이현우 오답노트에 추가해줘', NOS)).toEqual([5, 6]);
    expect(detectProblemNos('3번이랑 5번 비교해줘', NOS)).toEqual([3, 5]);
  });

  it('중복은 한 번만', () => {
    expect(detectProblemNos('6번 다시, 6번 또', NOS)).toEqual([6]);
  });

  it('오탐 케이스는 하나도 안 잡는다', () => {
    expect(detectProblemNos('3단계에서 [3점] 2026년 2.7', NOS)).toEqual([]);
  });

  it('유효 번호만 남기고 범위 밖은 버린다', () => {
    expect(detectProblemNos('5번 30번 12번', NOS)).toEqual([5, 12]);
  });

  it('아무것도 없으면 빈 배열', () => {
    expect(detectProblemNos('그냥 질문이야', NOS)).toEqual([]);
    expect(detectProblemNos('', NOS)).toEqual([]);
  });
});

describe('detectProblemNo — 찾아야 하는 경우', () => {
  it('"6번" 형태', () => {
    expect(detectProblemNo('6번 문제에 이상한 점이 없어?', NOS)).toBe(6);
  });

  it('띄어쓴 "6 번"', () => {
    expect(detectProblemNo('6 번 다시 설명해줘', NOS)).toBe(6);
  });

  it('"문제 6" / "문항 6"', () => {
    expect(detectProblemNo('문제 6 풀이 좀', NOS)).toBe(6);
    expect(detectProblemNo('문항 12 답이 왜 3이야?', NOS)).toBe(12);
  });

  it('붙여 쓴 "문제6"', () => {
    expect(detectProblemNo('문제6 조건이 이상해', NOS)).toBe(6);
  });

  it('"#6"', () => {
    expect(detectProblemNo('#6 확인 부탁', NOS)).toBe(6);
    expect(detectProblemNo('# 6 확인 부탁', NOS)).toBe(6);
  });

  it('"6번째"', () => {
    expect(detectProblemNo('6번째 문제 설명해줘', NOS)).toBe(6);
  });

  it('두 자리 번호', () => {
    expect(detectProblemNo('22번 마지막 문제 해설', NOS)).toBe(22);
    expect(detectProblemNo('16번 보기 ㄷ이 왜 틀려?', NOS)).toBe(16);
  });

  it('여러 개가 언급되면 첫 번째를 쓴다', () => {
    expect(detectProblemNo('3번과 7번 중 뭐가 더 어려워?', NOS)).toBe(3);
  });

  it('문장 끝/중간 어디에 있어도 찾는다', () => {
    expect(detectProblemNo('이거 풀어줘 8번', NOS)).toBe(8);
    expect(detectProblemNo('아까 말한 8번 말이야', NOS)).toBe(8);
  });

  it('앞에 "제" 가 붙어도 찾는다', () => {
    expect(detectProblemNo('제9번 풀이', NOS)).toBe(9);
  });
});

describe('detectProblemNo — 잡으면 안 되는 경우', () => {
  const negatives: Array<[string, string]> = [
    ['단계 표기', '3단계까지는 이해했어'],
    ['차수 표기', '2차 방정식이 뭐야?'],
    ['학기 표기', '1학기 중간고사 범위 알려줘'],
    ['연도 표기', '2026년 시험 경향 알려줘'],
    ['배점 표기', '[3점] 문항은 왜 쉬워?'],
    ['지수 표기', 'x^2 + 1 을 인수분해해줘'],
    ['소수점', '평균이 2.7 인데 맞아?'],
    ['날짜', '2026-07-31 에 시험 봐'],
    ['단순 숫자', '5 를 대입하면?'],
    ['점수', '80점 맞으려면?'],
    ['등호 수식', 'a = 4x^2 + 2x - 1 정리해줘'],
    ['쪽 표기', '3쪽 내용 설명해줘'],
    ['개수 표기', '문제 유형 3개 알려줘'],
  ];

  for (const [label, text] of negatives) {
    it(`${label}: "${text}"`, () => {
      expect(detectProblemNo(text, NOS)).toBeNull();
    });
  }

  it('소수점 뒤 숫자에 "번" 이 붙어도 자리수 중간이면 버린다', () => {
    // 2.7 의 7 을 7번으로 오인하지 않는다.
    expect(detectProblemNo('2.7번', NOS)).toBeNull();
  });

  it('자리수 중간을 잘라 쓰지 않는다', () => {
    // 121번은 시험지에 없다 -> 21번으로 축약해 추측하지 않는다.
    expect(detectProblemNo('121번 문제', NOS)).toBeNull();
  });

  it('"번째" 뒤에 다른 단위가 오면 문항이 아니다', () => {
    expect(detectProblemNo('2번째 줄이 이상해', NOS)).toBeNull();
    expect(detectProblemNo('3번째 단계를 모르겠어', NOS)).toBeNull();
    expect(detectProblemNo('4번째 글자가 뭐야?', NOS)).toBeNull();
  });

  it('시험지에 없는 번호는 버린다', () => {
    expect(detectProblemNo('30번 문제 풀어줘', NOS)).toBeNull();
    expect(detectProblemNo('0번 문제', NOS)).toBeNull();
  });

  it('문항 목록이 비어 있으면 아무것도 찾지 않는다', () => {
    expect(detectProblemNo('6번 문제', [])).toBeNull();
  });

  it('빈 문자열은 null', () => {
    expect(detectProblemNo('', NOS)).toBeNull();
  });
});

describe('detectProblemNo — 범위가 다른 시험지', () => {
  it('availableNos 를 그대로 존중한다', () => {
    expect(detectProblemNo('5번 문제', [1, 2, 3])).toBeNull();
    expect(detectProblemNo('3번 문제', [1, 2, 3])).toBe(3);
  });

  it('오탐 후보를 건너뛰고 뒤에 있는 유효한 번호를 찾는다', () => {
    // 30번은 없고 그 뒤 12번은 있다.
    expect(detectProblemNo('30번 아니고 12번', NOS)).toBe(12);
  });
});
