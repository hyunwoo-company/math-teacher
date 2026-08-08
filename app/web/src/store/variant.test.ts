/**
 * 변형 문제 생성: 스토어 + 목 API 통합 테스트.
 *
 * 목 클라이언트는 실제 SSE 바이트를 만들어 실제 파서를 통과시키므로,
 * 이 테스트는 "스트리밍 -> 파싱 -> variants 상태 반영" 경로 전체를 검증한다.
 */

import { beforeEach, describe, expect, it } from 'vitest';
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

  it.each<VariantMode>(['number', 'condition', 'number_condition'])(
    '%s 모드: 스트리밍 후 계약 형식(## 문제/정답/풀이)의 마크다운이 채워진다',
    async (mode) => {
      await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, mode);

      const list = useWorkspace.getState().variants[KEY];
      expect(list).toHaveLength(1);
      const entry = list?.[0];
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
      const running = state.variants[KEY]?.find((entry) => entry.status === 'running');
      if (running && running.streamingText) seen.push(running.streamingText);
    });

    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    unsubscribe();

    expect(seen.length).toBeGreaterThan(5);
    const first = seen[0] ?? '';
    const later = seen[5] ?? '';
    expect(later.length).toBeGreaterThan(first.length);
  }, 30_000);

  it('같은 문항에서 여러 번 생성하면 결과가 순서대로 쌓인다', async () => {
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'condition');

    const list = useWorkspace.getState().variants[KEY];
    expect(list).toHaveLength(2);
    expect(list?.[0]?.mode).toBe('number');
    expect(list?.[1]?.mode).toBe('condition');
    expect(list?.every((entry) => entry.status === 'done')).toBe(true);
  }, 30_000);

  it('서로 다른 문항의 결과는 각자의 키로 분리된다', async () => {
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 2, 'number');

    const { variants } = useWorkspace.getState();
    expect(variants[__internal.variantKey(MOCK_FILE_ID, 1)]).toHaveLength(1);
    expect(variants[__internal.variantKey(MOCK_FILE_ID, 2)]).toHaveLength(1);
  }, 30_000);

  it('API 키 모드에서는 토큰과 비용이 누적된다', async () => {
    useWorkspace.setState({ provider: 'apikey' });
    await useWorkspace.getState().generateVariant(MOCK_FILE_ID, 1, 'number');

    const { variants, totals } = useWorkspace.getState();
    expect(variants[KEY]?.[0]?.cost?.total_krw).toBeGreaterThan(0);
    expect(totals.billedCalls).toBe(1);
    expect(totals.usd).toBeGreaterThan(0);
  }, 30_000);
});
