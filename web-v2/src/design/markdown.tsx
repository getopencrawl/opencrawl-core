import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import type {Components} from 'react-markdown';
import {Table} from './components.js';

function readableLink(href: string | undefined) {
  if (href?.startsWith('#')) return href;
  try {
    const url = new URL(href ?? '');
    if (['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password) return href;
  } catch { /* Local file references stay text; the original source remains available. */ }
  return undefined;
}

const components: Components = {
  // A captured document sits beneath the page's own H1.
  h1: ({children, id, className}) => <h2 id={id} className={className}>{children}</h2>,
  h2: ({children, id, className}) => <h3 id={id} className={className}>{children}</h3>,
  h3: ({children, id, className}) => <h4 id={id} className={className}>{children}</h4>,
  h4: ({children, id, className}) => <h5 id={id} className={className}>{children}</h5>,
  h5: ({children, id, className}) => <h6 id={id} className={className}>{children}</h6>,
  table: ({children}) => <Table label="Memory table">{children}</Table>,
  pre: ({children}) => <pre className="code-block" tabIndex={0} role="region" aria-label="Code block">{children}</pre>,
  a: ({href, children}) => {
    const safe = readableLink(href);
    return safe ? <a href={safe} target={safe.startsWith('#') ? undefined : '_blank'} rel={safe.startsWith('#') ? undefined : 'noopener noreferrer'}>{children}</a> : <>{children}</>;
  },
  // Reading a captured file must not load arbitrary remote images or trackers.
  img: ({alt}) => <span>{alt || 'Image'}</span>,
};

/** Read-only Markdown rendered as React nodes, with no embedded HTML execution. */
export function Markdown({children}: {children: string}) {
  return <div className="oc-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm, remarkFrontmatter]} components={components}>{children}</ReactMarkdown></div>;
}
