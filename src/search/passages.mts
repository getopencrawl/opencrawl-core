/** Search indexes passages, not whole records. A passage is short enough that BM25 length
 * normalisation, 800-character excerpts and learned-sparse encoders (512 tokens) all see the
 * whole of it, so a fact deep inside a long reply or tool result is still matched and quoted.
 * Passages exactly partition the text (joining them restores it), ending at a paragraph, line,
 * sentence or word boundary when one falls in the last quarter of the window. */
export const PASSAGE_CHARS = 2000;

export function passages(text: string, size = PASSAGE_CHARS): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const from = start + Math.floor(size * 0.75), window = text.slice(from, end);
      for (const separator of ['\n\n', '\n', '. ', ' ']) {
        const at = window.lastIndexOf(separator);
        if (at >= 0) {end = from + at + separator.length; break;}
      }
      // Never split a surrogate pair.
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    out.push(text.slice(start, end));
    start = end;
  }
  return out;
}
