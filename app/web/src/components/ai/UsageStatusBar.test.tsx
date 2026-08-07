/**
 * agy 쿼터 사용량 상태 바: 세션 토큰 + (있으면) 최근 7일 토큰.
 */

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { UsageStatusBar } from '@/components/ai/UsageStatusBar';
import { useWorkspace } from '@/store/workspace';
import type { UsageSummaryResponse } from '@/types/api';

const initial = useWorkspace.getState();

const sessionTotals = {
  usage: { input_tokens: 12345 },
  usd: 0,
  krw: 0,
  billedCalls: 0,
  subscriptionCalls: 0,
} as const;

const summary: UsageSummaryResponse = {
  windows: {
    last_24h: { tokens: 1000, calls: 2 },
    last_7_days: { tokens: 67890, calls: 5 },
    total: { tokens: 200000, calls: 30 },
  },
};

beforeEach(() => {
  useWorkspace.setState(initial, true);
});

describe('UsageStatusBar', () => {
  it('요약이 있으면 세션과 최근 7일 토큰을 모두 표시한다', () => {
    useWorkspace.setState({ totals: sessionTotals, usageSummary: summary });
    render(<UsageStatusBar />);
    expect(screen.getByText('세션 12,345')).toBeInTheDocument();
    expect(screen.getByText('최근 7일 67,890')).toBeInTheDocument();
  });

  it('요약이 없으면 세션만 표시한다(화면이 깨지지 않는다)', () => {
    useWorkspace.setState({ totals: sessionTotals, usageSummary: null });
    render(<UsageStatusBar />);
    expect(screen.getByText('세션 12,345')).toBeInTheDocument();
    expect(screen.queryByText(/최근 7일/)).toBeNull();
  });
});
