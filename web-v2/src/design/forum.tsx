import {useId} from 'react';
import type {ReactNode, Ref} from 'react';

interface ForumPanelProps {
  title: string;
  breadcrumb?: ReactNode;
  status: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  busy?: boolean;
  ref?: Ref<HTMLElement>;
}

/** Shared bulletin-board structure. Routing and retrieval stay with the product page. */
export function ForumPanel({title, breadcrumb, status, children, footer, busy, ref}: ForumPanelProps) {
  const id = useId();
  return (
    <>
      {breadcrumb && <div className="oc-forum-breadcrumb">{breadcrumb}</div>}
      <section className="oc-forum" aria-labelledby={id} ref={ref} aria-busy={busy || undefined}>
        <header className="oc-forum-heading">
          <h2 id={id}>{title}</h2>
        </header>
        <div className="oc-forum-summary" role="status">{status}</div>
        {children}
        {footer && <footer className="oc-forum-footer">{footer}</footer>}
      </section>
    </>
  );
}

interface ForumPostProps {
  anchor: string;
  author: ReactNode;
  title?: ReactNode;
  metadata: ReactNode;
  children: ReactNode;
}

export function ForumPost({anchor, author, title, metadata, children}: ForumPostProps) {
  return (
    <article className="oc-forum-post" data-board-anchor={anchor}>
      <div className="oc-forum-author">{author}</div>
      <div className="oc-forum-content">
        <header className="oc-forum-post-heading">
          {title && <h3>{title}</h3>}
          <div className="oc-forum-post-meta">{metadata}</div>
        </header>
        <div className="oc-forum-post-text">{children}</div>
      </div>
    </article>
  );
}
