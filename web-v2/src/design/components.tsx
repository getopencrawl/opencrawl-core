import {cloneElement, isValidElement, useEffect, useId, useRef, useState} from 'react';
import type {ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes} from 'react';
import {Link} from '../router.tsx';
import type {LinkProps} from 'react-router';
import {Icon} from './icons.tsx';

type Styled<T> = Omit<T, 'style'>;
type SurfaceProps = Styled<HTMLAttributes<HTMLElement>>;
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'plain';
export interface ButtonProps extends Styled<ButtonHTMLAttributes<HTMLButtonElement>> {
  variant?: ButtonVariant;
  busy?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}
export function Button({variant = 'secondary', busy = false, className = '', disabled, children, type = 'button', ...props}: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy || props['aria-busy'] || undefined} className={`oc-button ${variant} ${className}`}>{busy && <Icon name="loader" className="oc-spin"/>}{children}</button>;
}
export function LinkButton({variant = 'secondary', className = '', ...props}: Styled<LinkProps> & {variant?: ButtonVariant}) {
  return <Link {...props} className={`oc-button ${variant} ${className}`}/>;
}
/** One static mark and wordmark for workspace and focused headers. */
export function Brand({className = '', reloadDocument = false}: {className?: string; reloadDocument?:boolean}) {
  return <Link className={`oc-brand ${className}`} to="/" reloadDocument={reloadDocument} aria-label="OpenCrawl home"><img src="/assets/opencrawl-mark.svg" width="38" height="20" alt=""/><span>opencrawl</span></Link>;
}
/** A link that leaves the product; internal paths use Link or LinkButton. */
export function ExternalLink({href, children, className = ''}: {href: string; children: ReactNode; className?: string}) {
  return <a className={`oc-external-link ${className}`} href={href} target="_blank" rel="noopener noreferrer">{children}<Icon name="external" size={16}/></a>;
}
export function Input({className = '', ...props}: Styled<InputHTMLAttributes<HTMLInputElement>> & {ref?: React.Ref<HTMLInputElement>}) {
  return <input {...props} className={`oc-input ${className}`}/>;
}
export function Select({className = '', ...props}: Styled<SelectHTMLAttributes<HTMLSelectElement>>) {
  return <select {...props} className={`oc-select ${className}`}/>;
}
export function Textarea({className = '', ...props}: Styled<TextareaHTMLAttributes<HTMLTextAreaElement>> & {ref?: React.Ref<HTMLTextAreaElement>}) {
  return <textarea {...props} className={`oc-textarea ${className}`}/>;
}
export function Field({label, hint, error, children, className = ''}: {label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string}) {
  const id = useId();
  const descriptionId = `${id}-description`;
  const child = isValidElement<Record<string, unknown>>(children) ? cloneElement(children, {id: children.props.id ?? id, 'aria-describedby': [children.props['aria-describedby'], hint || error ? descriptionId : undefined].filter(Boolean).join(' ') || undefined, 'aria-invalid': error ? true : children.props['aria-invalid']}) : children;
  return <div className={`oc-field ${className}`}><label htmlFor={isValidElement<Record<string, unknown>>(children) ? String(children.props.id ?? id) : id}>{label}</label>{child}{(hint || error) && <div className={error ? 'oc-field-error' : 'oc-field-hint'} id={descriptionId} role={error ? 'alert' : undefined}>{error || hint}</div>}</div>;
}
export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** @deprecated Workspace page headers share one visual hierarchy. */
  variant?: 'default' | 'report';
}
export function PageHeader({title, description, actions}: PageHeaderProps) {
  return <header className="oc-page-header"><div className="oc-page-introduction"><h1 tabIndex={-1} data-page-heading>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</header>;
}
/** Sidebar destinations share one frame; form and prose measures belong inside it. */
export type PageProps = Omit<SurfaceProps, 'title'> & Omit<PageHeaderProps, 'variant'> & {
  /** @deprecated Sidebar destinations always use the default full-width grid. */
  bodyWidth?: 'wide' | 'narrow';
  bodyClassName?: string;
};
export function Page({title, description, actions, bodyWidth = 'wide', bodyClassName = '', className = '', children, ...props}: PageProps) {
  return <div {...props} className={`oc-page ${className}`}><PageHeader title={title} description={description} actions={actions}/><div className={`oc-page-body oc-page-body-${bodyWidth} ${bodyClassName}`}>{children}</div></div>;
}
export function Section({title, description, actions, children, className = '', headingLevel = 2, ...props}: Omit<SurfaceProps, 'title'> & {title?: ReactNode; description?: ReactNode; actions?: ReactNode; headingLevel?: 2 | 3}) {
  const id = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return <section {...props} className={`oc-section ${className}`} aria-labelledby={title ? id : props['aria-labelledby']}>{(title || description || actions) && <div className="oc-section-heading"><div>{title && <Heading id={id}>{title}</Heading>}{description && <p>{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>}{children}</section>;
}
export function Notice({tone = 'info', title, children, className = ''}: {tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children: ReactNode; className?: string}) {
  return <div className={`oc-notice oc-notice-${tone} ${className}`} role={tone === 'danger' ? 'alert' : 'status'}>{title && <strong>{title}</strong>}<div>{children}</div></div>;
}
export function StatusBadge({tone = 'neutral', children, className = '', variant = 'default'}: {tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode; className?: string; variant?: 'default' | 'pill'}) {
  return <span className={`oc-badge oc-badge-${tone}${variant === 'pill' ? ' oc-status-pill' : ''} ${className}`}>{children}</span>;
}
export function EmptyState({title, description, action, actions}: {title: string; description?: ReactNode; action?: ReactNode; actions?: ReactNode}) {
  return <div className="oc-empty"><h3>{title}</h3>{description && <p>{description}</p>}{(action || actions) && <div className="actions">{action || actions}</div>}</div>;
}
export function LoadingState({label = 'Loading workspace…'}: {label?: string}) {
  return <div className="oc-loading" role="status" aria-live="polite"><span className="sr-only">{label}</span><span/><span/><span/></div>;
}
export function Table({label, children, className = ''}: {label: string; children: ReactNode; className?: string}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {const element = ref.current; if (!element) return; const update = () => setOverflow(element.scrollWidth > element.clientWidth + 1); update(); const observer = new ResizeObserver(update); observer.observe(element); return () => observer.disconnect();}, [children]);
  return <div className={`oc-table-container ${className}`}><div ref={ref} className="oc-table-scroll" role="region" aria-label={label} tabIndex={overflow ? 0 : undefined}><table>{children}</table></div>{overflow && <p className="oc-table-hint">Scroll to see all columns.</p>}</div>;
}
export function Dialog({open, onClose, title, description, children, actions, className = ''}: {open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {const element = ref.current; if (!element) return; if (open && !element.open) element.showModal(); else if (!open && element.open) element.close();}, [open]);
  return <dialog ref={ref} className={`oc-dialog ${className}`} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} onCancel={event => {event.preventDefault(); onClose();}} onClose={event => {if (!event.currentTarget.open) onClose();}} onClick={event => {if (event.target === event.currentTarget) {const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();}}}><div className="oc-dialog-header"><h2 id={`${id}-title`}>{title}</h2><Button variant="quiet" className="oc-icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></Button></div>{description && <p id={`${id}-description`} className="muted">{description}</p>}<div className="oc-dialog-body">{children}</div>{actions && <div className="oc-dialog-actions">{actions}</div>}</dialog>;
}
export function CopyField({value, label, multiline = false}: {value: string; label: string; multiline?: boolean}) {
  const [state, setState] = useState<'idle' | 'copied' | 'error'>('idle');
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {if (state === 'idle') return; const timeout = window.setTimeout(() => setState('idle'), 2000); return () => window.clearTimeout(timeout);}, [state]);
  const copy = async () => {try {await navigator.clipboard.writeText(value); setState('copied');} catch {field.current?.focus(); field.current?.select(); setState('error');}};
  return <div className="oc-copy-field"><Field label={label}>{multiline ? <Textarea ref={field} readOnly value={value} rows={4} className="mono"/> : <Input ref={field} readOnly value={value} className="mono"/>}</Field><Button variant="quiet" onClick={() => void copy()} aria-label={`Copy ${label}`}><Icon name={state === 'copied' ? 'check' : 'copy'}/>{state === 'copied' ? 'Copied' : 'Copy'}</Button><span className="sr-only" role="status">{state === 'copied' ? 'Copied to clipboard.' : state === 'error' ? 'Copy unavailable. Select and copy the text.' : ''}</span></div>;
}
export function Tabs({items, value, onChange, label}: {items: ReadonlyArray<{value: string; label: string}>; value: string; onChange: (value: string) => void; label: string}) {
  const ref = useRef<HTMLDivElement>(null);
  return <div className="oc-tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={event => {const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')); const focused = buttons.findIndex(button => button === document.activeElement); let index = focused < 0 ? items.findIndex(item => item.value === value) : focused; if (event.key === 'ArrowRight') index = (index + 1) % items.length; else if (event.key === 'ArrowLeft') index = (index - 1 + items.length) % items.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = items.length - 1; else return; event.preventDefault(); const item = items[index]; if (!item) return; onChange(item.value); buttons[index]?.focus();}}>{items.map(item => <Button key={item.value} variant="plain" role="tab" aria-selected={item.value === value} tabIndex={item.value === value ? 0 : -1} onClick={() => onChange(item.value)}>{item.label}</Button>)}</div>;
}

export interface MetricItem {label: string; value: ReactNode; note?: ReactNode; title?: string; /** How the number is calculated, shown when the question mark is hovered or focused. */ help?: string}
function MetricHelp({label, help}: {label: string; help: string}) {
  const id = useId();
  return <span className="report-help"><button type="button" className="report-help-button" aria-label={`How ${label} is calculated`} aria-describedby={id}>?</button><span className="report-help-text" role="tooltip" id={id}>{help}</span></span>;
}
export function MetricGrid({items}: {items: ReadonlyArray<MetricItem>}) {
  return <dl className="report-metrics">{items.map(item => <div className="report-metric" key={item.label}><dt>{item.label}{item.help && <MetricHelp label={item.label} help={item.help}/>}</dt><dd><span className="report-metric-value" title={item.title}>{item.value}</span>{item.note && <span className="report-metric-note">{item.note}</span>}</dd></div>)}</dl>;
}

export function BarList({rows, total, label}: {rows: ReadonlyArray<{name: string; count: number}>; total?: number; label: string}) {
  const maximum = total ?? Math.max(0, ...rows.map(row => row.count));
  if (!rows.length) return <p className="report-note">Nothing yet.</p>;
  return <ul className="report-bars" aria-label={label}>{rows.map(row => <li key={row.name}><span className="report-bar-label" title={row.name}>{row.name}</span><svg className="report-bar-track" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect width={maximum > 0 && row.count > 0 ? Math.min(100, Math.max(2, row.count / maximum * 100)) : 0} height="6" rx="1"/></svg><span className="report-bar-count">{row.count.toLocaleString('en-US')}</span></li>)}</ul>;
}

export function ActivityChart({daily}: {daily: ReadonlyArray<{date: string; sessions: number; events: number}>}) {
  if (!daily.length) return <p className="report-note">No activity yet.</p>;
  const peak = Math.max(0, ...daily.map(day => day.sessions));
  const maximum = Math.max(1, peak);
  const width = 100 / daily.length;
  const busiest = daily.reduce((best, day) => day.sessions > best.sessions ? day : best, daily[0]!);
  const sessions = (value: number) => `${value.toLocaleString('en-US')} ${value === 1 ? 'session' : 'sessions'}`;
  return <figure className="report-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label={`Agent sessions per day. Busiest day ${busiest.date} with ${sessions(busiest.sessions)}.`}>{daily.map((day, index) => {
    const height = day.sessions ? Math.max(3, day.sessions / maximum * 100) : 0;
    return <rect key={day.date} x={index * width + width * .15} y={100 - height} width={width * .7} height={height} rx=".6"><title>{`${day.date}: ${sessions(day.sessions)}, ${day.events.toLocaleString('en-US')} events`}</title></rect>;
  })}</svg><figcaption><span>{daily[0]!.date}</span><span>Peak {sessions(peak)} a day</span><span>{daily.at(-1)!.date}</span></figcaption></figure>;
}

/** Shared daily line chart with a keyboard-readable data table. */
export function DailyLineChart({daily, label}: {daily: ReadonlyArray<{date: string; average: number; peak: number; partial: boolean}>; label: string}) {
  const [selected, setSelected] = useState<string | null>(null);
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(760);
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));});
    observer.observe(element);
    return () => observer.disconnect();
  }, [daily.length]);
  if (!daily.length) return <p className="report-note">No captured session spans yet.</p>;
  const maximum = Math.max(1, Math.ceil(Math.max(...daily.map(day => day.peak)) / 4) * 4);
  const plotWidth = width - 68;
  const x = (index: number) => 44 + index / Math.max(1, daily.length - 1) * plotWidth;
  const y = (value: number) => 216 - value / maximum * 192;
  const path = (key: 'average' | 'peak') => daily.map((day, i) => `${i ? 'L' : 'M'}${x(i)},${y(day[key])}`).join(' ');
  const number = (value: number) => value.toLocaleString('en-US', {maximumFractionDigits: 2});
  const detail = daily.find(day => day.date === selected) ?? daily.at(-1)!;
  const description = (day: typeof detail) => `${day.date}${day.partial ? ' (partial)' : ''}: average ${number(day.average)}, peak ${number(day.peak)} sessions`;
  const labels = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
  return <figure ref={figure} className="report-line-chart" aria-label={label}>
    <div className="report-line-legend"><span className="report-line-average">Daily average</span><span className="report-line-peak">Daily peak</span></div>
    <svg viewBox={`0 0 ${width} 250`} role="img" aria-label={`${label}. ${description(detail)}. Daily values are in the table below.`}>
      {[0, 1, 2, 3, 4].map(i => <g key={i}><line className="report-line-grid" x1="44" x2={width - 24} y1={y(i * maximum / 4)} y2={y(i * maximum / 4)}/><text x="34" y={y(i * maximum / 4) + 4} textAnchor="end">{number(i * maximum / 4)}</text></g>)}
      <path className="report-line-peak" d={path('peak')}/><path className="report-line-average" d={path('average')}/>
      {daily.map((day, i) => <g key={day.date}>
        <circle className="report-line-peak" cx={x(i)} cy={y(day.peak)} r="3"/>
        <circle className="report-line-average" cx={x(i)} cy={y(day.average)} r="3"/>
        <rect className="report-line-hit" x={Math.max(40, x(i) - plotWidth / Math.max(1, daily.length - 1) / 2)} y="20" width={plotWidth / Math.max(1, daily.length - 1)} height="200" onMouseEnter={() => setSelected(day.date)}><title>{description(day)}</title></rect>
      </g>)}
      {labels.map(i => <text key={i} x={x(i)} y="242" textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}>{daily[i]!.date.slice(5)}</text>)}
    </svg>
    <figcaption>{description(detail)}. UTC.</figcaption>
    <details className="report-line-values"><summary>Daily values</summary><Table label={`${label} daily values`}><thead><tr><th scope="col">Day (UTC)</th><th scope="col">Daily average</th><th scope="col">Daily peak</th></tr></thead><tbody>{daily.map(day => <tr key={day.date}><th scope="row">{day.date}{day.partial ? ' (partial)' : ''}</th><td>{number(day.average)}</td><td>{number(day.peak)}</td></tr>)}</tbody></Table></details>
  </figure>;
}

export {Icon} from './icons.tsx';
