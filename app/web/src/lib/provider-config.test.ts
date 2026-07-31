import { describe, expect, it } from 'vitest';
import {
  defaultModelForProvider,
  isProviderAvailable,
  modelsForProvider,
  resolveProviderConfig,
} from '@/lib/provider-config';
import type { EnvResponse } from '@/types/api';

const CLAUDE = [
  { id: 'claude-opus-5', label: 'Opus', input_usd_per_mtok: 5, output_usd_per_mtok: 25 },
  { id: 'claude-sonnet-5', label: 'Sonnet', input_usd_per_mtok: 3, output_usd_per_mtok: 15 },
];

function baseEnv(partial: Partial<EnvResponse>): EnvResponse {
  return {
    mode: 'desktop',
    subscription: { available: true, cli_path: 'C:/claude.exe', reason: 'ok' },
    api_key_set: false,
    models: CLAUDE,
    usd_krw: 1400,
    ...partial,
  };
}

describe('resolveProviderConfig — 새 형식(agy)', () => {
  const env = baseEnv({
    providers: {
      agy: {
        available: true,
        reason: 'ok',
        models: [
          { id: 'gemini-3-flash', label: 'Flash', default: true },
          { id: 'gemini-3.1-pro', label: 'Pro' },
        ],
      },
      subscription: {
        available: true,
        reason: 'ok',
        cli_path: 'C:/claude.exe',
        models: [{ id: 'claude-opus-5', label: 'Opus' }],
      },
      apikey: { available: false, models: [{ id: 'claude-opus-5', label: 'Opus' }] },
    },
    default_provider: 'agy',
  });

  it('providers 구조를 인식한다', () => {
    const config = resolveProviderConfig(env);
    expect(config.hasProvidersShape).toBe(true);
    expect(config.options.map((option) => option.id)).toEqual(['agy', 'subscription', 'apikey']);
  });

  it('default_provider 를 기본으로 쓴다', () => {
    expect(resolveProviderConfig(env).defaultProvider).toBe('agy');
  });

  it('provider 별 모델을 준다', () => {
    const config = resolveProviderConfig(env);
    expect(modelsForProvider(config, 'agy').map((m) => m.id)).toEqual([
      'gemini-3-flash',
      'gemini-3.1-pro',
    ]);
    expect(defaultModelForProvider(config, 'agy')).toBe('gemini-3-flash');
  });

  it('agy 는 quota 과금 방식', () => {
    const config = resolveProviderConfig(env);
    expect(config.options.find((o) => o.id === 'agy')?.billing).toBe('quota');
  });

  it('apikey 사용 불가는 available=false 로 표시(선택지에는 남김)', () => {
    const config = resolveProviderConfig(env);
    expect(isProviderAvailable(config, 'apikey')).toBe(false);
    expect(config.options.some((o) => o.id === 'apikey')).toBe(true);
  });
});

describe('resolveProviderConfig — agy만 가능(Claude CLI 없음)', () => {
  const env = baseEnv({
    subscription: { available: false, cli_path: null, reason: 'cli_missing' },
    providers: {
      agy: { available: true, reason: 'ok', models: [{ id: 'gemini-3-flash', label: 'F', default: true }] },
      subscription: {
        available: false,
        reason: 'cli_missing',
        cli_path: null,
        models: [{ id: 'claude-opus-5', label: 'Opus' }],
      },
      apikey: { available: false, models: [] },
    },
    default_provider: 'agy',
  });

  it('구독은 비활성이지만 목록에는 있다(비활성 표시용)', () => {
    const config = resolveProviderConfig(env);
    expect(isProviderAvailable(config, 'subscription')).toBe(false);
    expect(isProviderAvailable(config, 'agy')).toBe(true);
  });

  it('default 가 사용 불가면 사용 가능한 첫 옵션으로 떨어진다', () => {
    const broken = { ...env, default_provider: 'subscription' as const };
    expect(resolveProviderConfig(broken).defaultProvider).toBe('agy');
  });
});

describe('resolveProviderConfig — 폴백(구버전 providers 없음)', () => {
  it('구독 가능하면 subscription 기본', () => {
    const config = resolveProviderConfig(baseEnv({}));
    expect(config.hasProvidersShape).toBe(false);
    expect(config.defaultProvider).toBe('subscription');
    expect(modelsForProvider(config, 'subscription').map((m) => m.id)).toContain('claude-opus-5');
  });

  it('구독 불가면 apikey 기본', () => {
    const config = resolveProviderConfig(
      baseEnv({ subscription: { available: false, cli_path: null, reason: 'web_mode' } }),
    );
    expect(config.defaultProvider).toBe('apikey');
    expect(isProviderAvailable(config, 'subscription')).toBe(false);
    expect(isProviderAvailable(config, 'apikey')).toBe(true);
  });

  it('agy 옵션은 폴백에서 없다', () => {
    const config = resolveProviderConfig(baseEnv({}));
    expect(config.options.some((o) => o.id === 'agy')).toBe(false);
  });
});
