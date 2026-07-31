/**
 * bbox 좌표계 변환 테스트.
 *
 * 하이라이트가 세로로 뒤집혀 실제 문제와 다른 위치에 그려진 버그의 회귀 방지.
 * 실제 extractor 출력값을 그대로 넣어 잠근다.
 */

import { describe, expect, it } from 'vitest';
import { normalizeViewportRect, toPdfSpaceRect } from '@/lib/pdf-geometry';

/** 이 시험지의 MediaBox: (0, 0, 595, 841) */
const A4 = { y0: 0, y1: 841 };

describe('toPdfSpaceRect', () => {
  it('extractor 실측값 4번(우상단)을 페이지 상단으로 변환한다', () => {
    // bbox=[303,68,562,223] (PyMuPDF, 좌상단 원점) -> PDF 표준
    expect(toPdfSpaceRect([303, 68, 562, 223], A4)).toEqual([303, 618, 562, 773]);
  });

  it('extractor 실측값 1번(좌상단)도 페이지 상단으로 변환한다', () => {
    // bbox=[32,69,290,142]
    expect(toPdfSpaceRect([32, 69, 290, 142], A4)).toEqual([32, 699, 290, 772]);
  });

  it('x 는 건드리지 않는다(좌/우 칼럼 구분 유지)', () => {
    const left = toPdfSpaceRect([32, 69, 290, 142], A4);
    const right = toPdfSpaceRect([303, 68, 562, 223], A4);
    expect(left[0]).toBe(32);
    expect(right[0]).toBe(303);
    expect(left[0]).toBeLessThan(right[0]);
  });

  it('페이지 상단 문제가 하단 문제보다 PDF 좌표에서 y 가 크다', () => {
    // PyMuPDF: 위쪽 문제가 y 가 작다. PDF 표준: 위쪽이 y 가 커야 한다.
    const top = toPdfSpaceRect([40, 70, 292, 430], A4); // 1번 위치
    const bottom = toPdfSpaceRect([40, 450, 292, 800], A4); // 22번 위치
    expect(top[1]).toBeGreaterThan(bottom[1]);
    expect(top[3]).toBeGreaterThan(bottom[3]);
    // 상단 문제의 위쪽 변은 페이지 높이에 가깝다.
    expect(top[3]).toBe(841 - 70);
    // 하단 문제의 아래쪽 변은 0 에 가깝다.
    expect(bottom[1]).toBe(841 - 800);
  });

  it('변환 후에도 위/아래 순서가 뒤집히지 않는다(y0 < y1)', () => {
    const rect = toPdfSpaceRect([32, 69, 290, 142], A4);
    expect(rect[1]).toBeLessThan(rect[3]);
  });

  it('MediaBox 원점이 0 이 아닌 문서도 높이(y1-y0)로 계산한다', () => {
    // 원점이 (0, 20) 인 문서: 높이 = 800
    expect(toPdfSpaceRect([10, 100, 50, 200], { y0: 20, y1: 820 })).toEqual([10, 600, 50, 700]);
  });

  it('bbox 가 짧거나 비어도 0 으로 채워 안전하게 처리한다', () => {
    expect(toPdfSpaceRect([], A4)).toEqual([0, 841, 0, 841]);
    expect(toPdfSpaceRect([10, 20], A4)).toEqual([10, 841, 0, 821]);
  });

  it('두 번 적용하면 원래 값으로 돌아온다(대합 성질)', () => {
    // toPdfSpaceRect([x0,y0,x1,y1]) = [x0, H-y1, x1, H-y0] 이므로 두 번 적용하면 원본이다.
    const original = [32, 69, 290, 142];
    expect(toPdfSpaceRect(toPdfSpaceRect(original, A4), A4)).toEqual(original);
  });
});

describe('normalizeViewportRect', () => {
  it('좌표 순서가 뒤집혀 와도 left/top/width/height 로 정리한다', () => {
    expect(normalizeViewportRect([100, 200, 40, 50])).toEqual({
      left: 40,
      top: 50,
      width: 60,
      height: 150,
    });
  });

  it('정상 순서도 그대로 처리한다', () => {
    expect(normalizeViewportRect([40, 50, 100, 200])).toEqual({
      left: 40,
      top: 50,
      width: 60,
      height: 150,
    });
  });

  it('폭/높이가 0 이어도 최소 크기를 보장해 클릭할 수 있게 한다', () => {
    const box = normalizeViewportRect([10, 10, 10, 10]);
    expect(box.width).toBe(2);
    expect(box.height).toBe(2);
  });

  it('값이 없으면 0 으로 본다', () => {
    expect(normalizeViewportRect([])).toEqual({ left: 0, top: 0, width: 2, height: 2 });
  });
});
