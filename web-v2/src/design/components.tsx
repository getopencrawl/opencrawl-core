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
export function PageHeader({title, description, actions}: {title: string; description?: ReactNode; actions?: ReactNode}) {
  return <div className="oc-page-header"><div><h1 tabIndex={-1} data-page-heading>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>;
}
export function Section({title, description, actions, children, className = '', ...props}: Omit<SurfaceProps, 'title'> & {title?: ReactNode; description?: ReactNode; actions?: ReactNode}) {
  const id = useId();
  return <section {...props} className={`oc-section ${className}`} aria-labelledby={title ? id : props['aria-labelledby']}>{(title || description || actions) && <div className="oc-section-heading"><div>{title && <h2 id={id}>{title}</h2>}{description && <p>{description}</p>}</div>{actions && <div className="actions">{actions}</div>}</div>}{children}</section>;
}
export function Notice({tone = 'info', title, children, className = ''}: {tone?: 'info' | 'success' | 'warning' | 'danger'; title?: string; children: ReactNode; className?: string}) {
  return <div className={`oc-notice oc-notice-${tone} ${className}`} role={tone === 'danger' ? 'alert' : 'status'}>{title && <strong>{title}</strong>}<div>{children}</div></div>;
}
export function StatusBadge({tone = 'neutral', children, className = ''}: {tone?: 'neutral' | 'success' | 'warning' | 'danger'; children: ReactNode; className?: string}) {
  return <span className={`oc-badge oc-badge-${tone} ${className}`}>{children}</span>;
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
  return <dialog ref={ref} className={`oc-dialog ${className}`} aria-labelledby={`${id}-title`} aria-describedby={description ? `${id}-description` : undefined} onCancel={event => {event.preventDefault(); onClose();}} onClose={onClose} onClick={event => {if (event.target === event.currentTarget) {const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();}}}><div className="oc-dialog-header"><h2 id={`${id}-title`}>{title}</h2><Button variant="quiet" className="oc-icon-button" aria-label="Close dialog" onClick={onClose}><Icon name="close"/></Button></div>{description && <p id={`${id}-description`} className="muted">{description}</p>}<div className="oc-dialog-body">{children}</div>{actions && <div className="oc-dialog-actions">{actions}</div>}</dialog>;
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
  return <div className="oc-tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={event => {let index = items.findIndex(item => item.value === value); if (event.key === 'ArrowRight') index = (index + 1) % items.length; else if (event.key === 'ArrowLeft') index = (index - 1 + items.length) % items.length; else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = items.length - 1; else return; event.preventDefault(); const item = items[index]; if (!item) return; onChange(item.value); ref.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]?.focus();}}>{items.map(item => <Button key={item.value} variant="plain" role="tab" aria-selected={item.value === value} tabIndex={item.value === value ? 0 : -1} onClick={() => onChange(item.value)}>{item.label}</Button>)}</div>;
}

export {Icon} from './icons.tsx';
