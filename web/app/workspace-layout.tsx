import React, { useEffect, useRef } from 'react';
export function WorkspaceLayout({
  children,
  routeKey,
  isList,
}: {
  children: React.ReactNode;
  routeKey: string;
  isList: boolean;
}): React.JSX.Element {
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    main.current?.focus();
  }, [routeKey]);
  return (
    <div className="studio-shell">
      <a
        className="skip-link"
        href="#main"
        onClick={(event) => {
          event.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <aside className="studio-sidebar">
        <a href="#" className="studio-brand">
          <img src="/rsi-mark.svg" className="brand-mark" alt="" />
          RSI <b>Studio</b>
        </a>
        <nav className="studio-nav" aria-label="Workspace">
          <span className="nav-caption">WORKSPACE</span>
          <a
            href="#"
            className="active"
            aria-current={isList ? 'page' : undefined}
          >
            Experiments
          </a>
        </nav>
        <div className="studio-sidebar-footer">
          Observation workspace
          <br />
          Read-only · Local Runtime
        </div>
      </aside>
      <div className="studio-workspace">
        <header className="studio-topbar">
          <a href="#" className="breadcrumbs">
            RSI / Experiments
          </a>
          <span className="muted">Read-only</span>
        </header>
        <main id="main" ref={main} tabIndex={-1} className="studio-main">
          {children}
        </main>
      </div>
    </div>
  );
}
