/**
 * 변형 문제 생성: 스토어 + 목 API 통합 테스트.
 *
 * 목 클라이언트는 실제 SSE 바이트를 만들어 실제 파서를 통과시키므로,
 * 이 테스트는 "스트리밍 -> 파싱 -> variants 상태 반영" 경로 전체를 검증한다.
 * 캐시 규칙(mode 별 1회 생성, done 이면 no-op, force 로만 재생성)도 함께 확인한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_FILE_ID } from '@/lib/mock/data';
import { useWorkspace, __internal } from '@/store/workspace';
import type { VariantMode } from '@/types/api';

const initial = useWorkspace.getState();

function reset() {
  useWorkspace.setState(initial, true);
  resetMockState();
  window.localStorage.clear();
}

const KEY = __internal.variantKey(MOCK_FILE_ID, 1);

describe('변형 문제 생성 (목 API)', () => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<VariantMode>(['number', 'condition', 'number_condition'])(
    '%s 모드: 스트리밍 후 계약 형식(## 문제/정답/풀이)의 마크다운이 채워진다',
    async (mode) => {
      await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, mode);

      const entry = useWorkspace.getState().variants[KEY]?.[mode];
      expect(entry?.mode).toBe(mode);
      expect(entry?.status).toBe('done');
      expect(entry?.streamingText).toBe('');
      // 계약: 마크다운 ## 문제 / ## 정답 / ## 풀이 + 수식 구분자 유지.
      expect(entry?.text).toContain('## 문제');
      expect(entry?.text).toContain('## 정답');
      expect(entry?.text).toContain('## 풀이');
      expect(entry?.text).toContain('\\[');
      expect(entry?.text).toContain('\\(');
      // 기본은 구독 모드이므로 cost 는 null(과금 없음).
      expect(entry?.cost).toBeNull();
    },
    30_000,
  );

  it('스트리밍 도중 부분 텍스트가 실제로 누적된다', async () => {
    const seen: string[] = [];
    const unsubscribe = useWorkspace.subscribe((state) => {
      const running = state.variants[KEY]?.number;
      if (running?.status === 'streaming' && running.streamingText) {
        seen.push(running.streamingText);
      }
    });

    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    unsubscribe();

    expect(seen.length).toBeGreaterThan(5);
    const first = seen[0] ?? '';
    const later = seen[5] ?? '';
    expect(later.length).toBeGreaterThan(first.length);
  }, 30_000);

  it('이미 done 인 mode 를 다시 호출하면 재생성하지 않는다(캐시 no-op)', async () => {
    const spy = vi.spyOn(api, 'generateVariant');

    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    expect(spy).toHaveBeenCalledTimes(1);
    const firstText = useWorkspace.getState().variants[KEY]?.number?.text;

    // 같은 mode 재호출: API 를 다시 부르지 않고 캐시를 유지한다.
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState().variants[KEY]?.number?.text).toBe(firstText);
  }, 30_000);

  it('force 로는 done 이어도 다시 생성한다("다시 생성")', async () => {
    const spy = vi.spyOn(api, 'generateVariant');

    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    expect(spy).toHaveBeenCalledTimes(1);

    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number', { force: true });
    expect(spy).toHaveBeenCalledTimes(2);
    expect(useWorkspace.getState().variants[KEY]?.number?.status).toBe('done');
  }, 30_000);

  it('3개 mode 는 서로 독립적으로 캐시된다', async () => {
    const spy = vi.spyOn(api, 'generateVariant');

    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'condition');
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number_condition');
    expect(spy).toHaveBeenCalledTimes(3);

    const byMode = useWorkspace.getState().variants[KEY];
    expect(byMode?.number?.status).toBe('done');
    expect(byMode?.condition?.status).toBe('done');
    expect(byMode?.number_condition?.status).toBe('done');

    // 아무 mode 나 재호출해도 추가 생성이 없다.
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'condition');
    expect(spy).toHaveBeenCalledTimes(3);
  }, 45_000);

  it('서로 다른 문항의 결과는 각자의 키로 분리된다', async () => {
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 2, 'number');

    const { variants } = useWorkspace.getState();
    expect(variants[__internal.variantKey(MOCK_FILE_ID, 1)]?.number?.status).toBe('done');
    expect(variants[__internal.variantKey(MOCK_FILE_ID, 2)]?.number?.status).toBe('done');
  }, 30_000);

  it('API 키 모드에서는 토큰과 비용이 누적된다', async () => {
    useWorkspace.setState({ provider: 'apikey' });
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');

    const { variants, totals } = useWorkspace.getState();
    expect(variants[KEY]?.number?.cost?.total_krw).toBeGreaterThan(0);
    expect(totals.billedCalls).toBe(1);
    expect(totals.usd).toBeGreaterThan(0);
  }, 30_000);
});
