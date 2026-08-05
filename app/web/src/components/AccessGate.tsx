'use client';

import { useState } from 'react';
import { Spinner } from '@/components/ui/Feedback';
import { useWorkspace } from '@/store/workspace';

/**
 * 접속 비밀번호(공유 암호) 로그인 화면.
 *
 * `env.auth_required === true` 이고 아직 접근이 확보되지 않았을 때만 보인다.
 * 담백하게 — 제목 + 비번 입력 1개 + [들어가기] + 인라인 에러.
 */
export function AccessGate() {
  const login = useWorkspace((state) => state.login);
  const authError = useWorkspace((state) => state.authError);
  const authChecking = useWorkspace((state) => state.authChecking);

  const [password, setPassword] = useState('');

  const submit = async () => {
    if (password.trim() === '' || authChecking) return;
    const ok = await login(password);
    if (ok) setPassword('');
  };

  return (
    <div className="flex h-full items-center justify-center bg-slate-100 p-6">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="w-full max-w-[360px] space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
      >
        <div>
          <h1 className="text-lg font-semibold text-slate-800">수학 문제풀이</h1>
          <p className="mt-1 text-[13px] text-slate-500">접속 비밀번호를 입력해 주세요.</p>
        </div>

        <div>
          <input
            type="password"
            aria-label="접속 비밀번호"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="비밀번호"
            className="w-full rounded border border-slate-300 px-3 py-2 text-[14px] text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
          />
          {authError ? (
            <p role="alert" className="mt-2 text-[12px] text-rose-600">
              {authError}
            </p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={password.trim() === '' || authChecking}
          className="inline-flex w-full items-center justify-center gap-2 rounded border border-blue-600 bg-blue-600 px-3 py-2 text-[14px] font-medium text-white hover:bg-blue-700 disabled:border-slate-300 disabled:bg-slate-200 disabled:text-slate-500"
        >
          {authChecking ? <Spinner className="h-4 w-4" /> : null}
          들어가기
        </button>
      </form>
    </div>
  );
}
