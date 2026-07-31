'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { AiPanel } from '@/components/ai/AiPanel';
import { CenterPanel } from '@/components/center/CenterPanel';
import { FileTreePanel } from '@/components/tree/FileTreePanel';
import { Onboarding } from '@/components/Onboarding';
import { ErrorState, LoadingState } from '@/components/ui/Feedback';
import { API_BASE, IS_MOCK } from '@/lib/config';
import { RIGHT_MAX, RIGHT_MIN, useWorkspace } from '@/store/workspace';

/**
 * 앱 루트(클라이언트 경계).
 *
 * 정적 export + Tauri 를 전제로 하므로 초기 데이터는 서버가 아니라 여기서 받아온다.
 * 서버 컴포넌트는 `app/layout.tsx` / `app/page.tsx` 의 정적 셸만 담당한다.
 */
export function Workspace() {
  const env = useWorkspace((state) => state.env);
  const envStatus = useWorkspace((state) => state.envStatus);
  const envError = useWorkspace((state) => state.envError);
  const onboardingSkipped = useWorkspace((state) => state.onboardingSkipped);
  const hasLocalApiKey = useWorkspace((state) => state.hasLocalApiKey);
  const providerConfig = useWorkspace((state) => state.providerConfig);
  const rightWidth = useWorkspace((state) => state.rightWidth);
  const toast = useWorkspace((state) => state.toast);

  const hydratePrefs = useWorkspace((state) => state.hydratePrefs);
  const loadEnv = useWorkspace((state) => state.loadEnv);
  const loadTree = useWorkspace((state) => state.loadTree);
  const setRightWidth = useWorkspace((state) => state.setRightWidth);
  const dismissToast = useWorkspace((state) => state.dismissToast);

  const [resizing, setResizing] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    // React StrictMode 이중 실행 방지.
    if (startedRef.current) return;
    startedRef.current = true;
    hydratePrefs();
    void loadEnv();
    void loadTree();
  }, [hydratePrefs, loadEnv, loadTree]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(dismissToast, 6000);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast]);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      setRightWidth(window.innerWidth - event.clientX);
    },
    [setRightWidth],
  );

  useEffect(() => {
    if (!resizing) return;
    const stop = () => setResizing(false);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [resizing, onPointerMove]);

  if (envStatus === 'idle' || envStatus === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-slate-100">
        <LoadingState label="작업 환경을 확인하는 중입니다…" />
      </main>
    );
  }

  if (envStatus === 'error' || !env) {
    return (
      <main className="flex h-full items-center justify-center bg-slate-100 p-6">
        <div className="w-full max-w-[520px]">
          <ErrorState
            message={envError ?? '작업 환경을 확인하지 못했습니다.'}
            hint={`백엔드 주소: ${API_BASE} · 로컬 서버가 실행 중인지 확인하세요.`}
            onRetry={() => {
              void loadEnv();
              void loadTree();
            }}
          />
        </div>
      </main>
    );
  }

  // agy 등 다른 provider 가 하나라도 쓸 수 있으면 온보딩이 필요 없다(계약 3-C).
  const agyAvailable =
    providerConfig?.options.some((option) => option.id === 'agy' && option.available) ?? false;
  // 웹 모드는 서버가 키를 저장하지 않으므로(계약 3-2) 브라우저 보관 여부도 함께 본다.
  const needsOnboarding =
    !onboardingSkipped &&
    !env.subscription.available &&
    !env.api_key_set &&
    !hasLocalApiKey &&
    !agyAvailable;

  if (needsOnboarding) {
    return (
      <main className="h-full">
        <Onboarding env={env} />
      </main>
    );
  }

  return (
    <main className="flex h-full flex-col">
      {IS_MOCK ? (
        <div className="flex items-center gap-2 bg-amber-100 px-3 py-1 text-[11px] text-amber-900">
          <span className="font-semibold">목 모드</span>
          <span>백엔드 없이 화면 흐름만 확인하는 중입니다. 데이터는 저장되지 않습니다.</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <FileTreePanel />
        <CenterPanel />

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="AI 패널 너비 조절"
          aria-valuenow={rightWidth}
          aria-valuemin={RIGHT_MIN}
          aria-valuemax={RIGHT_MAX}
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            setResizing(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') setRightWidth(rightWidth + 16);
            if (event.key === 'ArrowRight') setRightWidth(rightWidth - 16);
          }}
          className={clsx(
            'w-1 shrink-0 cursor-col-resize bg-slate-200 transition-colors hover:bg-blue-400',
            resizing && 'bg-blue-500',
          )}
        />

        <div style={{ width: rightWidth }} className="shrink-0 border-l border-slate-200">
          <AiPanel />
        </div>
      </div>

      {toast ? (
        <div
          role="status"
          className={clsx(
            'fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2 text-[13px] shadow-lg',
            toast.kind === 'error'
              ? 'border-rose-300 bg-rose-50 text-rose-800'
              : toast.kind === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                : 'border-slate-300 bg-white text-slate-700',
          )}
        >
          <div className="flex items-start gap-3">
            <div>
              <p>{toast.message}</p>
              {toast.hint ? <p className="mt-0.5 text-[11px] opacity-80">{toast.hint}</p> : null}
            </div>
            <button
              type="button"
              onClick={dismissToast}
              className="text-[11px] opacity-60 hover:opacity-100"
            >
              닫기
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
