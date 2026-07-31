/**
 * 오답노트 추가 의도 파싱 테스트.
 * 오탐(일반 질문을 추가로 오인)이 나쁘므로 negative 를 강하게 잠근다.
 */

import { describe, expect, it } from 'vitest';
import { parseNoteAddIntent } from '@/lib/note-intent';

const NOS = Array.from({ length: 22 }, (_, index) => index + 1);

describe('parseNoteAddIntent — 추가 의도', () => {
  it('"5번 6번 이현우 오답노트에 추가해줘"', () => {
    expect(parseNoteAddIntent('5번 6번 이현우 오답노트에 추가해줘', NOS)).toEqual({
      isAddIntent: true,
      problemNos: [5, 6],
      noteQuery: '이현우',
    });
  });

  it('"5번 이현우 오답노트에 담아줘"', () => {
    const result = parseNoteAddIntent('5번 이현우 오답노트에 담아줘', NOS);
    expect(result.isAddIntent).toBe(true);
    expect(result.problemNos).toEqual([5]);
    expect(result.noteQuery).toBe('이현우');
  });

  it('학생명 없이 "6번 오답노트에 추가" → 의도는 맞지만 noteQuery=null', () => {
    const result = parseNoteAddIntent('6번 오답노트에 추가해줘', NOS);
    expect(result.isAddIntent).toBe(true);
    expect(result.problemNos).toEqual([6]);
    expect(result.noteQuery).toBeNull();
  });

  it('"의" 소유격도 이름으로 뽑는다', () => {
    const result = parseNoteAddIntent('7번을 김민지의 오답노트에 저장해줘', NOS);
    expect(result.noteQuery).toBe('김민지');
    expect(result.problemNos).toEqual([7]);
  });

  it('공백이 있는 "오답 노트" 도 인식', () => {
    expect(parseNoteAddIntent('5번 이현우 오답 노트에 추가', NOS).isAddIntent).toBe(true);
  });
});

describe('parseNoteAddIntent — 추가 의도가 아닌 경우', () => {
  it('일반 풀이 요청은 아니다', () => {
    expect(parseNoteAddIntent('6번 문제 풀이해줘', NOS).isAddIntent).toBe(false);
  });

  it('비교 요청은 아니다', () => {
    expect(parseNoteAddIntent('3번이랑 5번 비교해서 설명해줘', NOS).isAddIntent).toBe(false);
  });

  it('오답노트를 그냥 언급만 한 것은 추가 의도가 아니다', () => {
    // "추가/담/넣/저장/등록" 동사가 없으면 의도로 보지 않는다.
    expect(parseNoteAddIntent('이현우 오답노트 열어줘', NOS).isAddIntent).toBe(false);
  });

  it('빈 문자열', () => {
    expect(parseNoteAddIntent('', NOS).isAddIntent).toBe(false);
  });
});
