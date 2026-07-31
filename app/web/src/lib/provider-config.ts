/**
 * `GET /api/env` 를 provider/모델 선택 UI 가 쓰기 좋은 형태로 정규화한다 (계약 3-C).
 *
 * 핵심: **하드코딩 금지, env 응답 기반 판단.**
 * - 새 백엔드: `providers:{agy,subscription,apikey}` + `default_provider` 를 준다.
 * - 구버전 백엔드: 그게 없다. 최상위 `models`/`subscription` 으로 폴백한다(안 깨지게).
 * - Claude CLI(subscription) 가 없으면 Claude 모델 선택지를 비활성/숨김(사용자 요구).
 */

import type { EnvResponse, ProviderChoice, ProviderModel } from '@/types/api';

export interface ProviderOption {
  id: ProviderChoice;
  label: string;
  available: boolean;
  /** 이 provider 로 쓸 수 있는 모델. */
  models: ProviderModel[];
  /** 과금 방식 안내(무과금/종량). */
  billing: 'quota' | 'subscription' | 'usage';
}

export interface ProviderConfig {
  /** 드롭다운에 노출할 옵션들(available=false 는 비활성 표시용으로 포함). */
  options: ProviderOption[];
  /** 기본 선택 provider. */
  defaultProvider: ProviderChoice;
  /** providers 구조를 백엔드가 준 새 형식인지(=agy 지원). */
  hasProvidersShape: boolean;
}

const PROVIDER_LABEL: Record<string, string> = {
  agy: 'Antigravity (무과금)',
  subscription: '구독 (Claude)',
  apikey: 'API 키 (Claude)',
  auto: '자동',
};

function billingOf(id: ProviderChoice): ProviderOption['billing'] {
  if (id === 'agy') return 'quota';
  if (id === 'apikey') return 'usage';
  return 'subscription';
}

/** Claude 모델 3종을 ProviderModel 로. 폴백에서 쓴다. */
function claudeModelsFromEnv(env: EnvResponse): ProviderModel[] {
  return env.models.map((model, index) => ({
    id: model.id,
    label: model.label,
    default: index === 0,
    input_usd_per_mtok: model.input_usd_per_mtok,
    output_usd_per_mtok: model.output_usd_per_mtok,
  }));
}

/**
 * env → provider 설정.
 */
export function resolveProviderConfig(env: EnvResponse): ProviderConfig {
  const providers = env.providers;

  // ── 새 형식 (agy 지원 백엔드) ──────────────────────────────────
  if (providers) {
    const options: ProviderOption[] = [];
    const order: ProviderChoice[] = ['agy', 'subscription', 'apikey'];
    for (const id of order) {
      const info = providers[id as 'agy' | 'subscription' | 'apikey'];
      if (!info) continue;
      options.push({
        id,
        label: PROVIDER_LABEL[id] ?? id,
        available: info.available,
        models: info.models ?? [],
        billing: billingOf(id),
      });
    }

    let defaultProvider = env.default_provider ?? null;
    // default 가 없거나 사용 불가면, 사용 가능한 첫 옵션으로.
    const firstAvailable = options.find((option) => option.available)?.id ?? null;
    if (
      defaultProvider == null ||
      !options.some((option) => option.id === defaultProvider && option.available)
    ) {
      defaultProvider = firstAvailable;
    }

    return {
      options,
      defaultProvider: defaultProvider ?? firstAvailable ?? 'apikey',
      hasProvidersShape: true,
    };
  }

  // ── 폴백 (구버전: providers 없음) ─────────────────────────────
  const claudeModels = claudeModelsFromEnv(env);
  const subAvailable = env.subscription.available;
  const options: ProviderOption[] = [
    {
      id: 'subscription',
      label: PROVIDER_LABEL.subscription ?? 'subscription',
      available: subAvailable,
      models: claudeModels,
      billing: 'subscription',
    },
    {
      id: 'apikey',
      label: PROVIDER_LABEL.apikey ?? 'apikey',
      // 웹/데스크톱 모두 키를 넣으면 쓸 수 있다. 여기서는 항상 선택 가능으로 두고,
      // 실제 키 유무는 상위(AiPanel/온보딩)가 판단한다.
      available: true,
      models: claudeModels,
      billing: 'usage',
    },
  ];

  return {
    options,
    defaultProvider: subAvailable ? 'subscription' : 'apikey',
    hasProvidersShape: false,
  };
}

/** 특정 provider 의 모델 목록. */
export function modelsForProvider(config: ProviderConfig, provider: ProviderChoice): ProviderModel[] {
  return config.options.find((option) => option.id === provider)?.models ?? [];
}

/** provider 의 기본 모델 id (default 표시 우선, 없으면 첫 번째). */
export function defaultModelForProvider(
  config: ProviderConfig,
  provider: ProviderChoice,
): string | null {
  const models = modelsForProvider(config, provider);
  return models.find((model) => model.default)?.id ?? models[0]?.id ?? null;
}

/** provider 가 이 config 에서 실제로 쓸 수 있는지. */
export function isProviderAvailable(config: ProviderConfig, provider: ProviderChoice): boolean {
  return config.options.some((option) => option.id === provider && option.available);
}
