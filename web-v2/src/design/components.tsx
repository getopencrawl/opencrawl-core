import {cloneElement, isValidElement, useEffect, useId, useRef, useState} from 'react';
import type {ButtonHTMLAttributes, HTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes} from 'react';
import {Link} from '../router.tsx';
import type {LinkProps} from 'react-router';
import type {IconName} from '../contracts.ts';
import {Icon} from './icons.tsx';

type Styled<T> = Omit<T, 'style'>;
type SurfaceProps = Styled<HTMLAttributes<HTMLElement>>;
export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-quiet' | 'plain';
export interface ButtonProps extends Styled<ButtonHTMLAttributes<HTMLButtonElement>> {
  variant?: ButtonVariant;
  busy?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
}
export function Button({variant = 'secondary', busy = false, className = '', disabled, children, type = 'button', ...props}: ButtonProps) {
  return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy || props['aria-busy'] || undefined} className={`oc-button ${variant} ${className}`}>{busy && <Icon name="loader" className="oc-spin"/>}{children}</button>;
}
export function ScrollControl({direction = 'down', className = '', children, ...props}: Omit<ButtonProps, 'variant'> & {direction?: 'up' | 'down'}) {
  return <Button {...props} className={`oc-scroll-control ${className}`}>{children}<Icon name="chevron-down" size={14} className={`oc-scroll-control-${direction}`}/></Button>;
}
export function LinkButton({variant = 'secondary', className = '', ...props}: Styled<LinkProps> & {variant?: ButtonVariant}) {
  return <Link {...props} className={`oc-button ${variant} ${className}`}/>;
}
/** Decorative beside an account name; retain initials until a safe image loads. */
export function Avatar({name, src}: {name: string; src?: string | null}) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  let image: string | null = null;
  if (src?.startsWith('/') && !src.startsWith('//') && !src.includes('\\')) image = src;
  else if (src) {
    try {const url = new URL(src); if (url.protocol === 'https:' && !url.username && !url.password) image = url.href;} catch { /* Initials cover missing or invalid URLs. */ }
  }
  const words = name.trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? [words[0], words[words.length - 1]].map(word => Array.from(word ?? '')[0] ?? '').join('') : Array.from(words[0] ?? '').slice(0, 2).join('')).toUpperCase();
  const visible = Boolean(image && loaded === image && failed !== image);
  return <span className="oc-avatar" aria-hidden="true" data-loaded={visible || undefined}>
    <span>{initials}</span>
    {image && failed !== image && <img key={image} src={image} alt="" width={32} height={32} decoding="async" draggable={false} referrerPolicy="no-referrer" onLoad={() => setLoaded(image)} onError={() => setFailed(image)}/>}
  </span>;
}
export function Brand({className = '', reloadDocument = false, markOnly = false}: {className?: string; reloadDocument?:boolean; markOnly?: boolean}) {
  const mark = <img src="/assets/opencrawl-mark.svg" width="38" height="20" alt=""/>;
  if (markOnly) return mark;
  return <Link className={`oc-brand ${className}`} to="/" reloadDocument={reloadDocument} aria-label="OpenCrawl home">{mark}<span>opencrawl</span></Link>;
}
/** A link that leaves the product; internal paths use Link or LinkButton. */
export function ExternalLink({href, children, className = ''}: {href: string; children: ReactNode; className?: string}) {
  return <a className={`oc-external-link ${className}`} href={href} target="_blank" rel="noopener noreferrer">{children}<Icon name="external" size={16}/></a>;
}
export function Input({className = '', ...props}: Styled<InputHTMLAttributes<HTMLInputElement>> & {ref?: React.Ref<HTMLInputElement>}) {
  return <input {...props} className={`oc-input ${className}`}/>;
}
export function ChoiceTiles<T extends string>({label, hint, name, value, onChange, options}: {
  label: string; hint?: string; name: string; value: T; onChange: (value: T) => void;
  options: ReadonlyArray<{value: T; title: string; description: string; icon: IconName | ReactElement}>;
}) {
  const id = useId();
  return <fieldset className="oc-choice-group" aria-describedby={hint ? id : undefined}>
    <legend>{label}</legend>
    {hint && <p className="oc-field-hint" id={id}>{hint}</p>}
    <div className="oc-choice-tiles">{options.map(option => {
      const optionId = id + '-' + option.value;
      return <label key={option.value} className="oc-choice-tile">
        <span className="oc-choice-symbol" aria-hidden="true">{typeof option.icon === 'string' ? <Icon name={option.icon} size={24}/> : option.icon}</span>
        <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)}
          aria-labelledby={optionId} aria-describedby={optionId + '-description'}/>
        <span className="oc-choice-copy"><strong id={optionId}>{option.title}</strong><span id={optionId + '-description'}>{option.description}</span></span>
      </label>;
    })}</div>
  </fieldset>;
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
  return <div {...props} className={`oc-page ${className}`}>
    <PageHeader title={title} description={description} actions={actions}/>
    <div className="oc-page-scroll">
      <div className={`oc-page-body oc-page-body-${bodyWidth} ${bodyClassName}`}>{children}</div>
    </div>
  </div>;
}
export function Section({title, description, actions, children, className = '', headingLevel = 2, ...props}: Omit<SurfaceProps, 'title'> & {title?: ReactNode; description?: ReactNode; actions?: ReactNode; headingLevel?: 2 | 3}) {
  const id = useId();
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  return <section {...props} className={`oc-section ${className}`} aria-labelledby={title ? id : props['aria-labelledby']}>{(title || description || actions) && <div className="oc-section-heading"><div>{title && <Heading id={id}>{title}</Heading>}{description && <p>{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>}{children}</section>;
}
export function Notice({tone = 'info', title, children, actions, className = ''}: {tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children: ReactNode; actions?: ReactNode; className?: string}) {
  return <div className={`oc-notice oc-notice-${tone} ${className}`} role={tone === 'danger' ? 'alert' : 'status'}>
    {title && <strong>{title}</strong>}
    {actions ? <div className="oc-notice-actions"><div>{children}</div>{actions}</div> : <div>{children}</div>}
  </div>;
}
export function StatusBadge({tone = 'neutral', children, className = '', variant = 'default'}: {tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode; className?: string; variant?: 'default' | 'pill'}) {
  return <span className={`oc-badge oc-badge-${tone}${variant === 'pill' ? ' oc-status-pill' : ''} ${className}`}>{children}</span>;
}
export function IntegrationLogo({src}: {src: string}) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="oc-integration-logo" aria-hidden="true">{failed === src
    ? <Icon name="sources" size={22}/>
    : <img src={src} alt="" width={32} height={32} onError={() => setFailed(src)}/>}</span>;
}
export interface IntegrationMetric {label: string; count: number; hint?: string; pending?: boolean;}
export interface IntegrationCardProps {
  name: string;
  icon: string;
  compact?: boolean;
  status?: {label: string; tone: 'neutral' | 'success' | 'warning' | 'danger'};
  metrics?: readonly IntegrationMetric[];
  metricsLabel?: string;
  emptyMessage?: string;
  note?: ReactNode;
  metadata?: ReactNode;
  action?: ReactNode;
}
/** One card for Usage and Integrations; callers retain their own measurement semantics. */
export function IntegrationCard({name, icon, compact = false, status, metrics, metricsLabel = `Content in ${name}`, emptyMessage, note, metadata, action}: IntegrationCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setOverflow(element.scrollHeight > element.clientHeight + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [compact, metrics, note, emptyMessage]);
  return <article className={`oc-integration-card${compact ? ' oc-integration-compact' : ''}`} aria-label={name}>
    <header className="oc-integration-header">
      <IntegrationLogo src={icon}/><h3 title={name}>{name}</h3>
    </header>
    {compact ? action : <>
      <div ref={ref} className="oc-integration-breakdown" role={overflow ? 'region' : undefined} aria-label={overflow ? metricsLabel : undefined} tabIndex={overflow ? 0 : undefined}>
        <div>
          {note}
          {metrics?.length ? <ul className="oc-integration-metrics" aria-label={metricsLabel}>{metrics.map(metric => <li key={metric.label}>
            <span>{metric.label}{metric.hint && <span className="sr-only">: {metric.hint}</span>}{metric.pending && <Icon name="loader" className="oc-spin" size={12}/>}</span><span>{metric.count.toLocaleString('en-US')}</span>
          </li>)}</ul> : emptyMessage && <p className="oc-integration-empty">{emptyMessage}</p>}
        </div>
      </div>
      <footer className="oc-integration-footer"><p className="oc-integration-meta" data-tone={status?.tone}>{metadata}</p>{action}</footer>
    </>}
  </article>;
}
export function EmptyState({title, description, action, actions}: {title: string; description?: ReactNode; action?: ReactNode; actions?: ReactNode}) {
  return <div className="oc-empty"><h3>{title}</h3>{description && <p>{description}</p>}{(action || actions) && <div className="actions">{action || actions}</div>}</div>;
}
export function LoadingState({label = 'Loading workspace…', spinner = false}: {label?: string; spinner?: boolean}) {
  if (!spinner) return <span className="oc-loading sr-only" role="status">{label}</span>;
  return <div className="oc-loading oc-loading-spinner" role="status"><Icon name="loader" className="oc-spin" size={20}/><span className="sr-only">{label}</span></div>;
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

const axisNumber = new Intl.NumberFormat('en-US', {notation: 'compact', maximumFractionDigits: 1});
/** Round gridline steps (1, 2, 2.5, 5 x 10^n) so axis labels read cleanly. */
function niceTicks(maximum: number) {
  if (maximum <= 0) return [0, 1];
  const raw = maximum / 4, magnitude = 10 ** Math.floor(Math.log10(raw)), scaled = raw / magnitude;
  const step = Math.max(1, (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10) * magnitude);
  return Array.from({length: Math.ceil(maximum / step) + 1}, (_, i) => i * step);
}

/** Daily bars with a y-axis and a hover or keyboard readout for each day. A null day was not tracked. */
export function DailyBarChart({days, label, unit}: {days: ReadonlyArray<{date: string; value: number | null}>; label: string; unit: (value: number) => string}) {
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(760);
  const [active, setActive] = useState<number | null>(null);
  useEffect(() => {
    const element = figure.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {if (entry) setWidth(Math.max(240, Math.round(entry.contentRect.width)));});
    observer.observe(element);
    return () => observer.disconnect();
  }, [days.length]);
  if (!days.length) return <p className="report-note">Nothing yet.</p>;
  const ticks = niceTicks(Math.max(0, ...days.map(day => day.value ?? 0)));
  const top = ticks.at(-1)!, height = 220, left = 52, right = 8, plotTop = 12, plotBottom = 192;
  const column = (width - left - right) / days.length;
  const y = (value: number) => plotBottom - value / top * (plotBottom - plotTop);
  const describe = (day: typeof days[number]) => `${day.date}: ${day.value == null ? 'not tracked' : unit(day.value)}`;
  const shown = active == null ? null : days[active];
  const labels = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  const tip = shown && (() => {
    const lines = [shown.date, shown.value == null ? 'Not tracked' : unit(shown.value)];
    const boxWidth = Math.max(...lines.map(line => line.length)) * 7 + 20, center = left + (active! + .5) * column;
    return {lines, boxWidth, x: Math.min(Math.max(center - boxWidth / 2, left), width - right - boxWidth)};
  })();
  return <figure ref={figure} className="report-bar-chart">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} tabIndex={0}
      onMouseLeave={() => setActive(null)} onBlur={() => setActive(null)}
      onKeyDown={event => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        setActive(current => Math.min(days.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : days.length)) + step)));
      }}>
      {ticks.map(tick => <g key={tick}>
        <line className="report-bar-grid" x1={left} x2={width - right} y1={y(tick)} y2={y(tick)}/>
        <text className="report-bar-axis" x={left - 8} y={y(tick) + 4} textAnchor="end">{axisNumber.format(tick)}</text>
      </g>)}
      {days.map((day, index) => {
        const value = day.value ?? 0, barHeight = value ? Math.max(2, plotBottom - y(value)) : 0;
        return <g key={day.date} className={index === active ? 'is-active' : undefined}>
          <rect className="report-bar" x={left + index * column + column * .15} y={plotBottom - barHeight} width={Math.max(1, column * .7)} height={barHeight} rx="2"/>
          <rect className="report-bar-hit" x={left + index * column} y={plotTop} width={column} height={plotBottom - plotTop} onMouseEnter={() => setActive(index)}/>
        </g>;
      })}
      {labels.map(i => <text key={i} className="report-bar-axis" x={left + (i + .5) * column} y={height - 6} textAnchor={i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}>{days[i]!.date}</text>)}
      {tip && <g className="report-bar-tip" pointerEvents="none">
        <rect x={tip.x} y={2} width={tip.boxWidth} height={42} rx="6"/>
        {tip.lines.map((line, i) => <text key={i} x={tip.x + 10} y={19 + i * 17} className={i ? 'report-bar-tip-value' : undefined}>{line}</text>)}
      </g>}
    </svg>
    <span className="sr-only" role="status">{shown ? describe(shown) : ''}</span>
  </figure>;
}

/** Shared daily line chart with per-day hover details. */
export function DailyLineChart({daily, label}: {daily: ReadonlyArray<{date: string; average: number; peak: number; partial: boolean}>; label: string}) {
  const figure = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(760);
  const [active, setActive] = useState<number | null>(null);
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
  const detail = daily.at(-1)!;
  const description = (day: typeof detail) => `${day.date}${day.partial ? ' (partial)' : ''}: average ${number(day.average)}, peak ${number(day.peak)} sessions`;
  const labels = [...new Set([0, Math.floor((daily.length - 1) / 2), daily.length - 1])];
  return <figure ref={figure} className="report-line-chart" aria-label={label}>
    <div className="report-line-legend"><span className="report-line-average">Daily average</span><span className="report-line-peak">Daily peak</span></div>
    <svg viewBox={`0 0 ${width} 250`} role="img" aria-label={`${label}. ${description(detail)}.`} tabIndex={0} onMouseLeave={() => setActive(null)} onBlur={() => setActive(null)}
      onKeyDown={event => {const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0; if (!step) return; event.preventDefault();
        setActive(current => Math.min(daily.length - 1, Math.max(0, (current ?? (step > 0 ? -1 : daily.length)) + step)));}}>
      {[0, 1, 2, 3, 4].map(i => <g key={i}><line className="report-line-grid" x1="44" x2={width - 24} y1={y(i * maximum / 4)} y2={y(i * maximum / 4)}/><text x="34" y={y(i * maximum / 4) + 4} textAnchor="end">{number(i * maximum / 4)}</text></g>)}
      <path className="report-line-peak" d={path('peak')}/><path className="report-line-average" d={path('average')}/>
      {daily.map((day, i) => <g key={day.date}>
        <circle className="report-line-peak" cx={x(i)} cy={y(day.peak)} r="3"/>
        <circle className="report-line-average" cx={x(i)} cy={y(day.average)} r="3"/>
        <rect className="report-line-hit" x={Math.max(40, x(i) - plotWidth / Math.max(1, daily.length - 1) / 2)} y="20" width={plotWidth / Math.max(1, daily.length - 1)} height="200" onMouseEnter={() => setActive(i)}/>
      </g>)}
      {active != null && daily[active] && (() => {
        const day = daily[active]!, lines = [day.date + (day.partial ? ' (partial)' : ''), `Average ${number(day.average)}`, `Peak ${number(day.peak)}`];
        const boxWidth = Math.max(...lines.map(line => line.length)) * 7 + 20, left = Math.min(Math.max(x(active) - boxWidth / 2, 44), width - 24 - boxWidth);
        return <g className="report-bar-tip" pointerEvents="none">
          <line className="report-line-grid" x1={x(active)} x2={x(active)} y1="20" y2="216"/>
          <rect x={left} y={2} width={boxWidth} height={58} rx="6"/>
          {lines.map((line, n) => <text key={n} x={left + 10} y={19 + n * 17} className={n ? 'report-bar-tip-value' : undefined}>{line}</text>)}
        </g>;
      })()}
      {labels.map(i => <text key={i} x={x(i)} y="242" textAnchor={i === 0 ? 'start' : i === daily.length - 1 ? 'end' : 'middle'}>{daily[i]!.date.slice(5)}</text>)}
    </svg>
    <span className="sr-only" role="status">{active != null && daily[active] ? description(daily[active]!) : ''}</span>
  </figure>;
}

export {Icon} from './icons.tsx';
