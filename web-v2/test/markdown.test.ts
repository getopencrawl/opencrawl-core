import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../src/design/markdown.js';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, {children: text}));

test('memory Markdown renders prose, lists, code and GFM tables through shared components', () => {
  const html = render('---\nname: internal metadata\n---\n# Release notes\n\nA **small** change with `inline code`.\n\n- First item\n- Second item\n\n```ts\nconst safe = true;\n```\n\n| Name | Status |\n| --- | --- |\n| Capture | Ready |');
  assert.match(html, /<h2>Release notes<\/h2>/);
  assert.doesNotMatch(html, /<h1|internal metadata/);
  assert.match(html, /<strong>small<\/strong>/);
  assert.match(html, /<ul>\s*<li>First item/);
  assert.match(html, /<pre class="code-block"[^>]*><code class="language-ts">const safe = true;/);
  assert.match(html, /class="oc-table-scroll"[^>]*role="region"[^>]*aria-label="Memory table"/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<td>Capture<\/td>/);
});

test('captured Markdown cannot execute HTML, load remote images, or create unsafe links', () => {
  const html = render('<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n![A diagram](https://tracker.example/image.png)\n\n[Unsafe](javascript:alert%281%29) [Local](file:///private/secret) [Reference](https://example.com/guide)');
  assert.doesNotMatch(html, /<script|<img|tracker\.example|javascript:|file:/);
  assert.match(html, /A diagram/);
  assert.match(html, /href="https:\/\/example.com\/guide" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Unsafe/);
});
