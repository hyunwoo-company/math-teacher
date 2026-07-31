/**
 * 앱이 쓰는 단일 API 진입점.
 * `NEXT_PUBLIC_MOCK=1` 이면 목 구현으로 갈아끼운다(호출부는 차이를 모른다).
 */

import { IS_MOCK } from '@/lib/config';
import { httpClient } from '@/lib/http-client';
import { mockClient } from '@/lib/mock/client';
import type { ApiClient } from '@/lib/api-client';

export const api: ApiClient = IS_MOCK ? mockClient : httpClient;

export { IS_MOCK };
export type { ApiClient };
