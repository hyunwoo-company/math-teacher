/**
 * 구독 불가 사유별 안내 문구 테스트.
 *
 * 특히 **Claude Code(CLI) 와 Claude 데스크톱 앱을 혼동시키지 않는지**를 잠근다.
 * 문구가 틀리면 사용자가 엉뚱한 프로그램을 설치한다.
 */

import { describe, expect, it } from 'vitest';
import {
  CLAUDE_CODE_DOCS_URL,
  resolveReason,
  subscriptionGuidance,
} from '@/lib/subscription-status';
import type { EnvResponse } from '@/types/api';

function env(
  subscription: EnvResponse['subscription'],
  mode: EnvResponse['mode'] = 'desktop',
): EnvResponse {
  return {
    mode,
    subscription,
    api_key_set: false,
    models: [
      {
        id: 'claude-opus-5',
        label: 'Claude Opus 5',
        input_usd_per_mtok: 5,
        output_usd_per_mtok: 25,
      },
    ],
    usd_krw: 1400,
  };
}

describe('resolveReason', () => {
  it('백엔드가 준 reason 을 그대로 쓴다', () => {
    expect(resolveReason(env({ available: false, cli_path: null, reason: 'cli_missing' }))).toBe(
      'cli_missing',
    );
    expect(
      resolveReason(env({ available: false, cli_path: 'C:/claude.exe', reason: 'not_logged_in' })),
    ).toBe('not_logged_in');
    expect(resolveReason(env({ available: false, cli_path: null, reason: 'disabled' }))).toBe(
      'disabled',
    );
    expect(resolveReason(env({ available: true, cli_path: 'C:/claude.exe', reason: 'ok' }))).toBe(
      'ok',
    );
  });

  it('reason 이 없는 구버전 백엔드도 처리한다(현재 8100 이 이 상태였다)', () => {
    // 웹 모드
    expect(resolveReason(env({ available: false, cli_path: null }, 'web'))).toBe('web_mode');
    // 데스크톱 + CLI 없음
    expect(resolveReason(env({ available: false, cli_path: null }))).toBe('cli_missing');
    // 데스크톱 + CLI 있는데 불가 -> 로그인 문제로 추론
    expect(resolveReason(env({ available: false, cli_path: 'C:/claude.exe' }))).toBe(
      'not_logged_in',
    );
    // 사용 가능하면 ok
    expect(resolveReason(env({ available: true, cli_path: 'C:/claude.exe' }))).toBe('ok');
  });

  it('모르는 reason 값이 오면 available 로 판단한다', () => {
    expect(
      resolveReason(env({ available: false, cli_path: null, reason: 'quantum_flux' })),
    ).toBe('cli_missing');
    expect(
      resolveReason(env({ available: true, cli_path: 'C:/claude.exe', reason: 'quantum_flux' })),
    ).toBe('ok');
  });
});

describe('subscriptionGuidance', () => {
  it('구독이 가능하면 안내가 없다', () => {
    expect(subscriptionGuidance(env({ available: true, cli_path: 'C:/c.exe', reason: 'ok' }))).toBeNull();
  });

  it('cli_missing: Claude Code 설치 안내 + 데스크톱 앱과 다르다는 경고', () => {
    const guidance = subscriptionGuidance(
      env({ available: false, cli_path: null, reason: 'cli_missing' }),
    );
    expect(guidance?.title).toContain('Claude Code');
    expect(guidance?.description).toContain('CLI');
    // 데스크톱 앱과의 구분을 반드시 명시한다.
    expect(guidance?.description).toContain('데스크톱 앱');
    // "구독이면 추가 요금이 없다" 는 이점을 제목/본문 어디서든 밝혀야 한다.
    expect(`${guidance?.title} ${guidance?.description}`).toContain('추가 요금 없이');
    expect(guidance?.recheckable).toBe(true);
    expect(guidance?.showDocsLink).toBe(true);
  });

  it('not_logged_in: 설치는 됐고 로그인만 하면 된다고 안내한다', () => {
    const guidance = subscriptionGuidance(
      env({ available: false, cli_path: 'C:/claude.exe', reason: 'not_logged_in' }),
    );
    expect(guidance?.title).toContain('로그인');
    expect(guidance?.description).toContain('설치되어 있');
    expect(guidance?.recheckable).toBe(true);
  });

  it('sdk_missing: 사용자가 고칠 문제가 아님을 알린다', () => {
    const guidance = subscriptionGuidance(
      env({ available: false, cli_path: null, reason: 'sdk_missing' }),
    );
    expect(guidance?.description).toContain('claude-agent-sdk');
    expect(guidance?.description).toContain('담당자');
    expect(guidance?.showDocsLink).toBe(false);
  });

  it('web_mode: 구조적 제약이라 다시 확인이 의미 없다', () => {
    const guidance = subscriptionGuidance(
      env({ available: false, cli_path: null, reason: 'web_mode' }, 'web'),
    );
    expect(guidance?.title).toContain('웹');
    expect(guidance?.recheckable).toBe(false);
    expect(guidance?.showDocsLink).toBe(false);
  });

  it('disabled: 설정으로 꺼졌음을 알린다', () => {
    const guidance = subscriptionGuidance(
      env({ available: false, cli_path: null, reason: 'disabled' }),
    );
    expect(guidance?.title).toContain('꺼져');
    expect(guidance?.description).toContain('MATH_TEACHER_DISABLE_SUBSCRIPTION');
    expect(guidance?.recheckable).toBe(true);
  });

  it('모든 사유에 API 키 대안 경로가 들어 있다', () => {
    const reasons = ['cli_missing', 'not_logged_in', 'sdk_missing', 'web_mode', 'disabled'];
    for (const reason of reasons) {
      const guidance = subscriptionGuidance(env({ available: false, cli_path: null, reason }));
      expect(guidance).not.toBeNull();
      // 문구 본문이나 placeholder 중 어디서든 API 키를 안내해야 한다.
      const text = `${guidance?.description} ${guidance?.inputPlaceholder}`;
      expect(text).toContain('API 키');
    }
  });

  it('어떤 사유든 placeholder 가 비어 있지 않다', () => {
    const reasons = ['cli_missing', 'not_logged_in', 'sdk_missing', 'web_mode', 'disabled', 'zzz'];
    for (const reason of reasons) {
      const guidance = subscriptionGuidance(env({ available: false, cli_path: null, reason }));
      expect(guidance?.inputPlaceholder.length).toBeGreaterThan(5);
    }
  });

  it('문서 링크는 정해진 값만 쓴다', () => {
    expect(CLAUDE_CODE_DOCS_URL).toBe('https://code.claude.com/docs');
  });

  it('Claude 데스크톱 앱을 설치하라고 잘못 안내하지 않는다', () => {
    const reasons = ['cli_missing', 'not_logged_in', 'sdk_missing', 'disabled'];
    for (const reason of reasons) {
      const guidance = subscriptionGuidance(env({ available: false, cli_path: null, reason }));
      const text = `${guidance?.title} ${guidance?.description}`;
      // "데스크톱 앱을 설치" 같은 표현이 있으면 안 된다.
      expect(text).not.toMatch(/데스크톱 앱을 설치/);
      expect(text).not.toMatch(/Claude 데스크톱을 설치/);
    }
  });
});
