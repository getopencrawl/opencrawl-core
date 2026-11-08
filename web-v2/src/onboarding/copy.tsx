import {useEffect, useRef, useState} from 'react';
import {Button} from '../design/components.tsx';
import {Icon} from '../design/icons.tsx';

export function CommandSnippet({text, label}: {text: string; label: string}) {
  const [feedback, setFeedback] = useState<'copied' | 'selected' | null>(null);
  const code = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; if (timer.current) clearTimeout(timer.current);};}, []);
  async function copy() {
    if (timer.current) clearTimeout(timer.current);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (!mounted.current) return;
      setFeedback('copied');
      timer.current = setTimeout(() => setFeedback(null), 1500);
    } catch {
      if (!mounted.current) return;
      setFeedback('selected');
      if (code.current) {
        const range = document.createRange();
        range.selectNodeContents(code.current);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  }
  return <>
    <Button variant="plain" className="command-snippet" aria-label={label} disabled={!text} onClick={() => void copy()} data-copied={feedback === 'copied' ? '' : undefined} data-copy-error={feedback === 'selected' ? '' : undefined}>
      <code ref={code}>{text.split('\n').map((line, lineIndex) => <span key={lineIndex}>{lineIndex > 0 && '\n'}{line.split(' ').map((token, tokenIndex) => <span key={tokenIndex}>{tokenIndex > 0 && ' '}<span className="command-token">{token}</span></span>)}</span>)}</code>
      <span className="snippet-feedback" aria-hidden="true"><span className="snippet-icon"><Icon name="copy" /></span><span className="snippet-done">{feedback === 'selected' ? 'Selected' : 'Copied'}</span></span>
    </Button>
    {feedback === 'selected' && <p className="snippet-copy-help signal-instruction" role="status">Copy the selected text with your keyboard or selection menu.</p>}
    <span className="sr-only" role="status">{feedback === 'copied' ? 'Copied' : ''}</span>
  </>;
}
