/**
 * 접속 비밀번호 게이트 — 스토어 + 목 API 통합.
 *
 * NEXT_PUBLIC_MOCK_MODE='web-auth' 목 환경은 env.auth_required=true 를 주고,
 * 저장된 비번이 'friend' 일 때만 보호 요청을 통과시킨다(백엔드 미들웨어 흉내).
 * 로그인 → 진입 → 401 재잠금 → 로그아웃 경로를 여기서 검증한다.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetMockState } from '@/lib/mock/client';
import { MOCK_ACCESS_PASSWORD } from '@/lib/mock/data';
import { needsAccessGate, readStoredPassword, writeStoredPassword } from '@/lib/access-gate';
import { useWorkspace } from '@/store/workspace';

const initial = useWorkspace.getState();
let previousMode: string | undefined;

function reset() {
  useWorkspace.setState(initial, true);
}

beforeEach(() => {
  previousMode = process.env.NEXT_PUBLIC_MOCK_MODE;
  window.localStorage.clear();
  reset();
});

afterEach(() => {
  process.env.NEXT_PUBLIC_MOCK_MODE = previousMode;
  window.localStorage.clear();
  resetMockState();
});

/** 비번 요구 목 환경으로 전환하고 env 를 불러온다. */
async function loadAuthEnv() {
  process.env.NEXT_PUBLIC_MOCK_MODE = 'web-auth';
  resetMockState();
  await useWorkspace.getState().loadEnv();
}

describe('접속 비밀번호 게이트 (스토어)', () => {
  it('비번 요구 환경에서 저장 비번이 없으면 게이트를 띄운다', async () => {
    await loadAuthEnv();
    const { env, accessOk } = useWorkspace.getState();
    expect(env?.auth_required).toBe(true);
    expect(accessOk).toBe(false);
    expect(needsAccessGate(env, accessOk)).toBe(true);
  });

  it('틀린 비번은 거부하고 인라인 에러를 남긴다', async () => {
    await loadAuthEnv();
    const ok = await useWorkspace.getState().login('nope');
    expect(ok).toBe(false);
    const { accessOk, authError } = useWorkspace.getState();
    expect(accessOk).toBe(false);
    expect(authError).toBe('비밀번호가 올바르지 않습니다.');
    expect(readStoredPassword()).toBeNull();
  });

  it('맞는 비번이면 진입하고 비번을 저장한 뒤 트리를 불러온다', async () => {
    await loadAuthEnv();
    const ok = await useWorkspace.getState().login(MOCK_ACCESS_PASSWORD);
    expect(ok).toBe(true);

    const { accessOk, authError } = useWorkspace.getState();
    expect(accessOk).toBe(true);
    expect(authError).toBeNull();
    expect(readStoredPassword()).toBe(MOCK_ACCESS_PASSWORD);
    expect(needsAccessGate(useWorkspace.getState().env, accessOk)).toBe(false);

    // 진입 후 보호 요청이 통과한다(= 저장 비번이 헤더로 실려 검증을 통과).
    await useWorkspace.getState().loadTree();
    expect(useWorkspace.getState().treeStatus).toBe('ready');
    expect(useWorkspace.getState().nodes.length).toBeGreaterThan(0);
  }, 15_000);

  it('진입 후 비번이 무효화(401)되면 게이트로 되돌리고 세션 만료를 알린다', async () => {
    await loadAuthEnv();
    await useWorkspace.getState().login(MOCK_ACCESS_PASSWORD);
    expect(useWorkspace.getState().accessOk).toBe(true);

    // 서버 비번이 바뀐 상황을 흉내: 저장 비번을 틀린 값으로 바꾼다.
    writeStoredPassword('changed');
    // 아무 보호 요청이나 하면 목이 401 을 내고, 저수준 통로가 스토어를 잠근다.
    await useWorkspace.getState().loadTree();

    const { accessOk, authError } = useWorkspace.getState();
    expect(accessOk).toBe(false);
    expect(authError).toContain('세션이 만료');
    expect(readStoredPassword()).toBeNull();
  }, 15_000);

  it('로그아웃하면 저장 비번을 지우고 게이트로 되돌린다', async () => {
    await loadAuthEnv();
    await useWorkspace.getState().login(MOCK_ACCESS_PASSWORD);
    expect(useWorkspace.getState().accessOk).toBe(true);

    useWorkspace.getState().logout();
    expect(useWorkspace.getState().accessOk).toBe(false);
    expect(readStoredPassword()).toBeNull();
    expect(needsAccessGate(useWorkspace.getState().env, false)).toBe(true);
  }, 15_000);

  it('비번 미요구 환경(로컬)에서는 게이트 없이 바로 진입한다', async () => {
    // 기본 desktop 시나리오 = auth_required 없음.
    process.env.NEXT_PUBLIC_MOCK_MODE = 'desktop';
    resetMockState();
    await useWorkspace.getState().loadEnv();

    const { env, accessOk } = useWorkspace.getState();
    expect(env?.auth_required ?? false).toBe(false);
    expect(accessOk).toBe(true);
    expect(needsAccessGate(env, accessOk)).toBe(false);
  });
});
