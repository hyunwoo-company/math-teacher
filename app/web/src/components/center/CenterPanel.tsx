'use client';

import clsx from 'clsx';
import { api } from '@/lib/api';
import { PdfViewer } from '@/components/center/PdfViewer';
import { SolutionsTab } from '@/components/center/SolutionsTab';
import { NoteView } from '@/components/center/NoteView';
import { AddToNoteButton } from '@/components/center/AddToNoteButton';
import { EmptyState, ErrorState, InlineBadge, LoadingState } from '@/components/ui/Feedback';
import { formatDate } from '@/lib/format';
import { nodePath } from '@/lib/tree';
import { useWorkspace } from '@/store/workspace';

/** 가운데 패널: 시험지([PDF]/[풀이]) 또는 오답노트 항목 목록. */
export function CenterPanel() {
  const openKind = useWorkspace((state) => state.openKind);
  const selectedFileId = useWorkspace((state) => state.selectedFileId);
  const fileDetail = useWorkspace((state) => state.fileDetail);
  const fileStatus = useWorkspace((state) => state.fileStatus);
  const fileError = useWorkspace((state) => state.fileError);
  const activeTab = useWorkspace((state) => state.activeTab);
  const selectedProblemNo = useWorkspace((state) => state.selectedProblemNo);
  const focusRequest = useWorkspace((state) => state.focusRequest);
  const nodes = useWorkspace((state) => state.nodes);
  const solutions = useWorkspace((state) => state.solutions);

  const setActiveTab = useWorkspace((state) => state.setActiveTab);
  const focusProblem = useWorkspace((state) => state.focusProblem);
  const selectFileAgain = useWorkspace((state) => state.selectFile);

  if (openKind === 'note') {
    return <NoteView />;
  }

  if (openKind === 'none' || !selectedFileId) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-white">
        <EmptyState
          title="왼쪽에서 시험지를 선택하세요"
          description="폴더를 펼쳐 PDF 파일을 클릭하면 여기에 문제지가 표시됩니다. 왼쪽 상단 [오답노트] 탭에서는 학생별 오답을 모아 볼 수 있습니다."
          icon="📄"
        />
      </section>
    );
  }

  if (fileStatus === 'loading') {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-white">
        <LoadingState label="시험지를 불러오는 중입니다…" />
      </section>
    );
  }

  if (fileStatus === 'error' || !fileDetail) {
    return (
      <section className="flex min-w-0 flex-1 items-center justify-center bg-white">
        <div className="w-[420px]">
          <ErrorState
            message={fileError ?? '시험지를 불러오지 못했습니다.'}
            onRetry={() => {
              // 같은 파일을 다시 선택하려면 선택 상태를 우회해야 한다.
              const id = selectedFileId;
              useWorkspace.setState({ selectedFileId: null });
              void selectFileAgain(id);
            }}
          />
        </div>
      </section>
    );
  }

  const { node, problems } = fileDetail;
  const path = nodePath(nodes, node.id);
  const solvedCount = problems.filter((problem) => solutions[problem.no]?.status === 'done').length;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-white">
      <header className="border-b border-slate-200 px-3 py-2">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-[14px] font-semibold text-slate-800" title={node.name}>
            {node.name}
          </h1>
          {node.file ? (
            <>
              <InlineBadge>{node.file.pages}쪽</InlineBadge>
              <InlineBadge>{node.file.problem_count}문항</InlineBadge>
              <InlineBadge tone={node.file.mode === 'text' ? 'slate' : 'amber'}>
                {node.file.mode === 'text' ? '텍스트 추출' : '이미지 모드'}
              </InlineBadge>
            </>
          ) : null}
          <span className="ml-auto shrink-0 text-[11px] text-slate-400">
            등록 {formatDate(node.created_at)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-slate-400">{path.join(' / ')}</p>
      </header>

      <nav className="flex items-center gap-1 border-b border-slate-200 px-3">
        <TabButton active={activeTab === 'pdf'} onClick={() => setActiveTab('pdf')}>
          PDF
        </TabButton>
        <TabButton active={activeTab === 'solutions'} onClick={() => setActiveTab('solutions')}>
          풀이
          <span className="ml-1.5 rounded bg-slate-100 px-1 text-[10px] text-slate-500">
            {solvedCount}/{problems.length}
          </span>
        </TabButton>
      </nav>

      {problems.length > 0 ? (
        <div className="border-b border-slate-100 px-3 py-1.5">
          <div className="flex items-center gap-1 overflow-x-auto">
            <span className="shrink-0 pr-1 text-[11px] text-slate-400">문제</span>
            {problems.map((problem) => {
              const status = solutions[problem.no]?.status ?? 'empty';
              return (
                <button
                  key={problem.no}
                  type="button"
                  onClick={() => focusProblem(problem.no)}
                  title={`${problem.no}번 문제 (${problem.page}쪽) · 클릭하면 이 문제로 대화가 시작됩니다`}
                  className={clsx(
                    'h-6 w-7 shrink-0 rounded border text-[11px] tabular-nums',
                    selectedProblemNo === problem.no
                      ? 'border-blue-500 bg-blue-500 text-white'
                      : status === 'done'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : status === 'running'
                          ? 'border-blue-200 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50',
                  )}
                >
                  {problem.no}
                </button>
              );
            })}
          </div>
          {/* 계약 6: 문제 미선택 시 클릭이 대화 시작 트리거임을 알린다. */}
          {selectedProblemNo == null ? (
            <p className="mt-1 text-[11px] text-slate-400">
              문제 번호를 클릭하면 그 문제로 대화를 시작할 수 있습니다.
            </p>
          ) : (
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[11px] text-blue-700">
                {selectedProblemNo}번 문제가 선택되었습니다.
              </span>
              <AddToNoteButton
                sourceNodeId={node.id}
                problemNumbers={[selectedProblemNo]}
                compact
              />
            </div>
          )}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        {activeTab === 'pdf' ? (
          <PdfViewer
            fileUrl={api.fileRawUrl(node.id)}
            problems={problems}
            selectedProblemNo={selectedProblemNo}
            focusRequest={focusRequest}
            onSelectProblem={focusProblem}
          />
        ) : (
          <SolutionsTab />
        )}
      </div>
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        '-mb-px border-b-2 px-3 py-1.5 text-[13px] font-medium',
        active
          ? 'border-blue-600 text-blue-700'
          : 'border-transparent text-slate-500 hover:text-slate-700',
      )}
    >
      {children}
    </button>
  );
}
