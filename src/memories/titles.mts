const LIMIT = 120;
const generic = /^(?:memory|memories|memory summary|summary|overview|user|project|feedback|reference|notes?|task(?:\s+\d+)?|user profile|user preferences|general tips|reusable knowledge)$/i;

function label(value: string) {
  const plain = value.replace(/!?(?:\[([^\]]+)\])\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const characters = Array.from(plain);
  if (characters.length <= LIMIT) return plain;
  const prefix = characters.slice(0, LIMIT - 1).join('');
  return prefix.replace(/\s+\S*$/, '').trimEnd() + '…';
}

function words(value: string) {
  const text = value.replace(/[_-]+/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A display label from the file's own text; never changes captured content.
 * Bound both list (first passage) and viewer reads to the same opening window. */
export function memoryTitle(path: string, text: string) {
  const opening = text.slice(0, 16000).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(opening);
  const scalar = (key: string) => {
    const raw = new RegExp('^' + key + ':[\\t ]*(.*)$', 'm').exec(frontmatter?.[1] ?? '')?.[1]?.trim() ?? '';
    if (/^[|>](?:[-+\d]*)$/.test(raw)) return '';
    return label(raw.replace(/^(["'])([\s\S]*)\1$/, '$2'));
  };
  const title = scalar('title');
  if (title && !generic.test(title)) return title;
  const name = scalar('name');
  if (name && !generic.test(name)) return label(/^[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)+$/u.test(name) ? words(name) : name);

  const basename = path.split('/').at(-1)?.replace(/\.md$/i, '') ?? '';
  // These files cover many subjects; a subsection is not their document title.
  if (/^memory$/i.test(basename)) return 'Memory index';
  if (/^memory[_-]summary$/i.test(basename)) return 'Memory summary';

  const body = frontmatter ? opening.slice(frontmatter[0].length) : opening;
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null; continue;}
    if (fence) continue;
    const heading = /^\s{0,3}#{1,3}\s+(.+?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (!heading) continue;
    const candidate = label(heading);
    if (candidate && !generic.test(candidate) && !/^Task(?: Group)?\s*\d*\s*:/i.test(candidate)) return candidate;
  }
  const description = scalar('description');
  if (description) return description;
  // Codex rollout names begin with a timestamp and a four-character collision ID.
  const filename = basename.replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[A-Za-z0-9]{4}-/, '');
  return label(words(filename)) || 'Memory';
}
