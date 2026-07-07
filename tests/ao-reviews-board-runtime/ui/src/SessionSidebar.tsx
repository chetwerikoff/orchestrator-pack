import type { SidebarSession } from './review-types.js';

interface SessionSidebarProps {
  sessions: SidebarSession[];
  projects: Array<{ id: string; name?: string | null }>;
  selectedProjectId: string | null;
  onProjectChange: (projectId: string | null) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function SessionSidebar({
  sessions,
  projects,
  selectedProjectId,
  onProjectChange,
  collapsed,
  onToggleCollapsed,
}: SessionSidebarProps) {
  return (
    <aside className={`board-sidebar${collapsed ? ' board-sidebar--collapsed' : ''}`}>
      <div className="board-sidebar__header">
        <span className="board-sidebar__title">Sessions</span>
        <button
          type="button"
          className="board-sidebar__toggle"
          onClick={onToggleCollapsed}
          aria-label="Toggle sidebar"
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {!collapsed ? (
        <>
          <label className="board-sidebar__filter">
            <span>Project</span>
            <select
              value={selectedProjectId ?? 'all'}
              onChange={(event) => {
                const value = event.target.value;
                onProjectChange(value === 'all' ? null : value);
              }}
            >
              <option value="all">All projects</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name ?? project.id}
                </option>
              ))}
            </select>
          </label>

          <ul className="board-sidebar__list">
            {sessions.map((session) => (
              <li key={session.id} className="board-sidebar__item">
                <div className="board-sidebar__item-id">{session.id}</div>
                <div className="board-sidebar__item-meta">
                  {session.projectId ? `${session.projectId} · ` : ''}
                  {session.branch ?? 'no branch'}
                  {session.status ? ` · ${session.status}` : ''}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </aside>
  );
}
