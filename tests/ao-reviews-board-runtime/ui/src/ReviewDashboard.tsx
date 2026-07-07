/**
 * Derived from ComposioHQ/agent-orchestrator v0.9.2 packages/web/src/components/ReviewDashboard.tsx
 * Write actions disabled (read-only v1). Data via producer-mapped board rows.
 */
import { useMemo, useState } from 'react';
import { SessionSidebar } from './SessionSidebar.js';
import {
  COLUMN_HINTS,
  formatRelativeTime,
  formatStatus,
  groupRunsByColumn,
  parsePrNumber,
  REVIEW_BOARD_COLUMNS,
  REVIEW_COLUMN_LABELS,
  runCardKey,
  workerAvailabilityLabel,
  type BoardReviewRun,
  type ProjectOption,
  type ReviewBoardColumn,
  type SidebarSession,
} from './review-types.js';

const WRITE_DISABLED_TITLE =
  'Review write actions are disabled until the producer and documented daemon write API land.';

export interface ReviewBoardViewProps {
  runs: BoardReviewRun[];
  sidebarSessions?: SidebarSession[];
  projects: ProjectOption[];
  projectId?: string | null;
  projectName: string | null;
  dashboardLoadError?: string | null;
  onProjectChange?: (projectId: string | null) => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
}

/** Hook-free board view — safe for server render tests. */
export function ReviewBoardView({
  runs,
  sidebarSessions = [],
  projects,
  projectId = null,
  projectName,
  dashboardLoadError = null,
  onProjectChange,
  sidebarCollapsed = false,
  onToggleSidebar,
}: ReviewBoardViewProps) {
  const grouped = groupRunsByColumn(runs);
  const allProjectsView = !projectId;
  const activeRunCount = runs.filter((run) =>
    ['queued', 'reviewing', 'triage', 'waiting'].includes(run.status),
  ).length;
  const headerProjectLabel = projectName ?? (allProjectsView ? 'All projects' : 'Reviews');

  return (
    <div className="dashboard-app-shell">
      <header className="dashboard-app-header">
        <button
          type="button"
          className="dashboard-app-sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
        >
          ☰
        </button>
        <div className="dashboard-app-header__brand">
          <span className="dashboard-app-header__brand-dot" aria-hidden="true" />
          <span>Agent Orchestrator</span>
        </div>
        <span className="dashboard-app-header__sep" aria-hidden="true" />
        <span className="dashboard-app-header__project">{headerProjectLabel}</span>
        <span className="dashboard-app-header__mode">Reviews</span>
        <div className="dashboard-app-header__spacer" />
        <div className="dashboard-app-header__actions">
          <button
            type="button"
            className="dashboard-app-btn dashboard-app-btn--disabled"
            disabled
            title={WRITE_DISABLED_TITLE}
          >
            + New Review
          </button>
        </div>
      </header>

      <div className="dashboard-shell">
        <SessionSidebar
          sessions={sidebarSessions}
          projects={projects}
          selectedProjectId={projectId}
          onProjectChange={(nextProjectId) => onProjectChange?.(nextProjectId)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={onToggleSidebar ?? (() => undefined)}
        />

        <main className="dashboard-main review-dashboard-main">
          <div className="review-main-header">
            <div>
              <h1 className="dashboard-main__title">
                {projectName ? `${projectName} Reviews` : 'Reviews'}
              </h1>
              <p className="dashboard-main__subtitle">
                AO-local reviewer runs and worker handoffs
                {allProjectsView ? ' across all projects' : ' for this project'}.
              </p>
            </div>
            <div className="dashboard-stat-cards">
              <ReviewMetric label="Runs" value={runs.length} meta="Total review runs" />
              <ReviewMetric label="Active" value={activeRunCount} meta="Open review loops" />
            </div>
          </div>

          {dashboardLoadError ? (
            <div className="dashboard-alert" role="alert">
              {dashboardLoadError}
            </div>
          ) : null}

          {!dashboardLoadError && runs.length === 0 ? (
            <section className="review-empty-state">
              <div className="review-empty-state__title">No review runs yet</div>
              <p className="review-empty-state__body">
                Reviewer runs will appear here once the review producer populates per-session
                review data. The board runtime is connected — empty columns are expected until then.
              </p>
            </section>
          ) : (
            <div className="kanban-board-wrap">
              <div
                className="kanban-board review-kanban-board"
                data-columns={REVIEW_BOARD_COLUMNS.length}
              >
                {REVIEW_BOARD_COLUMNS.map((column) => (
                  <ReviewColumn key={column} column={column} runs={grouped[column]} allProjectsView={allProjectsView} />
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

function ReviewMetric({ label, value, meta }: { label: string; value: number; meta: string }) {
  return (
    <div className="dashboard-stat-card">
      <span className="dashboard-stat-card__value">{value}</span>
      <span className="dashboard-stat-card__label">{label}</span>
      <span className="dashboard-stat-card__meta">{meta}</span>
    </div>
  );
}

function ReviewColumn({
  column,
  runs,
  allProjectsView,
}: {
  column: ReviewBoardColumn;
  runs: BoardReviewRun[];
  allProjectsView: boolean;
}) {
  return (
    <div className="kanban-column review-kanban-column" data-review-column={column}>
      <div className="kanban-column__header">
        <div className="kanban-column__title-row">
          <div className="kanban-column__dot review-column-dot" data-review-column={column} />
          <span className="kanban-column__title">{REVIEW_COLUMN_LABELS[column]}</span>
          <span className="kanban-column__count">{runs.length}</span>
        </div>
        <p className="review-column-hint">{COLUMN_HINTS[column]}</p>
      </div>
      <div className="kanban-column-body">
        {runs.length > 0 ? (
          <div className="kanban-column__stack">
            {runs.map((run) => (
              <ReviewCard key={runCardKey(run)} run={run} allProjectsView={allProjectsView} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ReviewCard({
  run,
  allProjectsView,
}: {
  run: BoardReviewRun;
  allProjectsView: boolean;
}) {
  const prNumber = parsePrNumber(run.prUrl);
  const title = run.sessionId;
  const statusLabel = formatStatus(run.status);
  const secondaryText =
    run.body?.trim() ||
    (run.status === 'clean'
      ? 'Reviewer completed without open findings.'
      : `Review for ${run.sessionId}.`);
  const truthLine = `${formatStatus(run.prReviewStatus)} · ${formatStatus(run.latestRunStatus)} · worker ${workerAvailabilityLabel(run)}`;
  const dotClass =
    run.status === 'reviewing'
      ? 'card__adot--working'
      : run.status === 'clean'
        ? 'card__adot--ready'
        : run.status === 'triage' || run.status === 'failed'
          ? 'card__adot--waiting'
          : run.status === 'waiting'
            ? 'card__adot--ready'
            : 'card__adot--idle';

  return (
    <article className="session-card review-card" data-review-status={run.status}>
      <div className="session-card__header">
        <span className={`card__adot ${dotClass}`} />
        <span className="card__id">
          {allProjectsView && run.projectName ? `${run.projectName} · ` : ''}
          {run.sessionId}
        </span>
      </div>

      <div className="session-card__body">
        <p className="card__title">{title}</p>
        <div className="card__meta">
          {run.workerBranch ? <span className="card__branch">{run.workerBranch}</span> : null}
          {run.workerBranch && prNumber ? <span className="card__meta-sep">·</span> : null}
          {prNumber && run.prUrl ? (
            <a href={run.prUrl} target="_blank" rel="noreferrer" className="card__pr">
              #{prNumber}
            </a>
          ) : prNumber ? (
            <span className="card__pr">#{prNumber}</span>
          ) : null}
        </div>
        <p className="session-card__secondary">{secondaryText}</p>
        <p className="card__truth-line">{truthLine}</p>
      </div>

      <div className="session-card__footer">
        <span className="card__status">
          {statusLabel}
          {run.deliveredAt ? ` · updated ${formatRelativeTime(run.deliveredAt)}` : ''}
        </span>
        <div className="session-card__footer-actions">
          <button
            type="button"
            className="session-card__control session-card__control--disabled"
            disabled
            title={WRITE_DISABLED_TITLE}
          >
            Run
          </button>
          <button
            type="button"
            className="session-card__control session-card__control--disabled"
            disabled
            title={WRITE_DISABLED_TITLE}
          >
            Feedback
          </button>
        </div>
      </div>
    </article>
  );
}

export function ReviewDashboard(props: ReviewBoardViewProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const groupedRuns = useMemo(() => props.runs, [props.runs]);

  return (
    <ReviewBoardView
      {...props}
      runs={groupedRuns}
      sidebarCollapsed={sidebarCollapsed}
      onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
    />
  );
}
