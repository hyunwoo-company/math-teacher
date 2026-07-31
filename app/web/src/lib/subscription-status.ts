/**
 * 구독(Claude Code 인증)을 쓸 수 없는 이유별 안내 문구.
 *
 * ⚠️ 용어 주의: 필요한 것은 **Claude Code(터미널에서 쓰는 CLI)** 이고
 * **Claude 데스크톱 앱(채팅 GUI)이 아니다.** 데스크톱 앱을 설치해도 CLI 는 생기지 않으므로
 * 문구에서 반드시 구분한다. 혼동하면 사용자가 엉뚱한 것을 설치한다.
 *
 * 설치 방법은 링크만 안내한다. 구체적 명령을 문구에 박으면 나중에 틀린다.
 */

import type { EnvResponse, SubscriptionReason } from '@/types/api';

/** 공식 문서. 이 값 외의 URL 을 추측해서 쓰지 않는다. */
export const CLAUDE_CODE_DOCS_URL = 'https://code.claude.com/docs';

const KNOWN_REASONS: readonly SubscriptionReason[] = [
  'ok',
  'cli_missing',
  'not_logged_in',
  'sdk_missing',
  'web_mode',
  'disabled',
];

export type ResolvedReason = SubscriptionReason | 'unknown';

/**
 * `subscription.reason` 을 정규화한다.
 *
 * 구버전 백엔드는 이 필드를 주지 않는다. 그때는 확실히 아는 정보(mode, cli_path)로만
 * 추론하고, 그것으로도 모르면 'unknown' 을 준다(추측해서 단정하지 않는다).
 */
export function resolveReason(env: EnvResponse): ResolvedReason {
  const raw = env.subscription.reason;
  if (typeof raw === 'string' && (KNOWN_REASONS as readonly string[]).includes(raw)) {
    return raw as SubscriptionReason;
  }

  if (env.subscription.available) return 'ok';
  // reason 이 없는 구버전 백엔드용 추론.
  if (env.mode === 'web') return 'web_mode';
  if (env.subscription.cli_path == null) return 'cli_missing';
  // CLI 는 찾았는데 사용 불가 -> 로그인 문제일 가능성이 높지만 단정할 수는 없다.
  return 'not_logged_in';
}

export interface SubscriptionGuidance {
  reason: ResolvedReason;
  /** 한 줄 제목. */
  title: string;
  /** 상황 설명 + 다음에 할 일. */
  description: string;
  /** [다시 확인] 으로 해결될 수 있는 상황인지. */
  recheckable: boolean;
  /** Claude Code 문서 링크를 보여줄지. */
  showDocsLink: boolean;
  /** 입력창 placeholder. */
  inputPlaceholder: string;
}

/**
 * 이유별 안내. `available === true` 면 null (안내할 게 없다).
 */
export function subscriptionGuidance(env: EnvResponse): SubscriptionGuidance | null {
  if (env.subscription.available) return null;
  const reason = resolveReason(env);

  switch (reason) {
    case 'cli_missing':
      return {
        reason,
        title: 'Claude Code 를 설치하면 추가 요금 없이 쓸 수 있습니다',
        description:
          'Claude Code(터미널에서 쓰는 CLI)를 설치하고 로그인하면 구독으로 문제풀이를 쓸 수 있습니다. ' +
          'Claude 데스크톱 앱(채팅 GUI)과는 다른 프로그램이라, 데스크톱 앱만 설치해도 인식되지 않습니다. ' +
          '설치와 로그인을 마친 뒤 [다시 확인] 을 누르면 앱을 다시 켜지 않아도 감지됩니다.',
        recheckable: true,
        showDocsLink: true,
        inputPlaceholder: 'Claude Code 설치·로그인 또는 API 키 입력이 필요합니다',
      };

    case 'not_logged_in':
      return {
        reason,
        title: 'Claude Code 로그인이 필요합니다',
        description:
          'Claude Code 는 이 PC 에 설치되어 있지만 로그인되어 있지 않습니다. ' +
          '터미널에서 Claude Code 를 실행해 로그인한 뒤 [다시 확인] 을 누르세요.',
        recheckable: true,
        showDocsLink: true,
        inputPlaceholder: 'Claude Code 로그인 또는 API 키 입력이 필요합니다',
      };

    case 'sdk_missing':
      return {
        reason,
        title: '앱 구성이 완료되지 않았습니다',
        description:
          '구독 인증에 필요한 구성요소(claude-agent-sdk)가 서버에 설치되어 있지 않습니다. ' +
          '사용자가 고칠 수 있는 문제가 아니니 앱을 설치해 준 담당자에게 알려 주세요. ' +
          '그동안은 API 키로 사용할 수 있습니다.',
        recheckable: true,
        showDocsLink: false,
        inputPlaceholder: '구독 인증 구성요소가 없습니다. API 키를 입력해 주세요',
      };

    case 'web_mode':
      return {
        reason,
        title: '웹 버전에서는 구독을 쓸 수 없습니다',
        description:
          '서버가 사용자 PC 의 Claude Code 인증에 접근할 수 없기 때문입니다(구조적 제약). ' +
          '구독으로 쓰시려면 데스크톱 앱을 이용하시고, 웹에서는 API 키를 입력해 주세요.',
        recheckable: false,
        showDocsLink: false,
        inputPlaceholder: '웹 버전은 API 키 입력이 필요합니다',
      };

    case 'disabled':
      return {
        reason,
        title: '구독 모드가 설정으로 꺼져 있습니다',
        description:
          '서버에서 구독 모드를 비활성화한 상태입니다(MATH_TEACHER_DISABLE_SUBSCRIPTION). ' +
          '설정을 해제하고 서버를 다시 시작하면 쓸 수 있습니다. 지금은 API 키로 사용해 주세요.',
        recheckable: true,
        showDocsLink: false,
        inputPlaceholder: '구독 모드가 꺼져 있습니다. API 키를 입력해 주세요',
      };

    case 'ok':
    case 'unknown':
    default:
      return {
        reason: 'unknown',
        title: '구독 모드를 쓸 수 없습니다',
        description:
          '이유를 확인하지 못했습니다. Claude Code(터미널 CLI)의 설치·로그인 상태를 확인해 보시고, ' +
          '바로 쓰셔야 한다면 API 키를 입력해 주세요.',
        recheckable: true,
        showDocsLink: true,
        inputPlaceholder: '구독을 쓸 수 없습니다. API 키를 입력해 주세요',
      };
  }
}
