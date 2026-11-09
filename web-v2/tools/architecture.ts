import ts from 'typescript';

export interface ArchitectureViolation {file: string; line: number; rule: string; message: string}
const rawControls = new Set(['button', 'input', 'select', 'textarea', 'dialog', 'table']);
const controlRoles = new Set(['button', 'textbox', 'combobox', 'listbox', 'checkbox', 'radio', 'switch', 'slider', 'dialog', 'table', 'tablist']);
const isDesignFile = (file: string) => file.startsWith('src/design/');
const isNavigationOwner = (file: string) => file === 'src/app.tsx' || file === 'src/onboarding/shell.tsx';

/** Recognize static JSX values without pretending to resolve arbitrary runtime code. */
function staticValues(node: ts.Node | undefined): string[] {
  if (!node) return [];
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return staticValues(node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...staticValues(node.whenTrue), ...staticValues(node.whenFalse)];
  return [];
}

function hasInternalPath(node: ts.Node | undefined): boolean {
  if (!node) return false;
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
    return hasInternalPath(node.expression);
  }
  if (ts.isConditionalExpression(node)) return hasInternalPath(node.whenTrue) || hasInternalPath(node.whenFalse);
  if (ts.isTemplateExpression(node)) return /^\/(?!\/)/.test(node.head.text);
  return staticValues(node).some(value => /^\/(?!\/)/.test(value));
}

/** Call with authored roots only; generated bundles and dependencies are not source. */
export function inspectAuthoredFiles(files: ReadonlyArray<string>): ArchitectureViolation[] {
  return files.filter(file => /\.[cm]?jsx?$/.test(file)).map(file => ({
    file, line: 1, rule: 'typescript-only', message: 'Author TypeScript only. Compiled JavaScript belongs in dist.',
  }));
}

/** Authored interface punctuation must not use centered-dot separators, even encoded. */
export function inspectUiText(file: string, text: string): ArchitectureViolation[] {
  const forbidden = /\u00b7|&(?:middot|centerdot|#0*183|#x0*b7);?|\\u(?:00b7|\{0*b7\})|\\xb7/gi;
  return [...text.matchAll(forbidden)].map(match => ({
    file,
    line: text.slice(0, match.index).split('\n').length,
    rule: 'no-centered-dot-separators',
    message: 'Centered-dot separators are forbidden. Use natural punctuation, spacing, or separate lines.',
  }));
}

/** Deliberately small: failures are concrete code ownership rules, not taste scores. */
export function inspectSource(file: string, text: string): ArchitectureViolation[] {
  const violations = inspectUiText(file, text);
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const report = (node: ts.Node, rule: string, message: string) => violations.push({file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, message});
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, 'strict-types', 'Use a concrete type or narrow unknown; explicit any is forbidden.');
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (tag === 'h1' && !isDesignFile(file) && !file.startsWith('src/onboarding/')) report(node, 'shared-page-heading', 'Use Page or PageHeader for workspace titles. Onboarding retains its focused presentation.');
      if (rawControls.has(tag) && !isDesignFile(file)) report(node, 'shared-controls', `Use the design-system ${tag} wrapper.`);
      if (tag === 'nav' && !isNavigationOwner(file)) report(node, 'single-navigation', 'Workspace navigation belongs to AppShell; onboarding step navigation belongs to its shell.');
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = attribute.name.getText(source);
        if (tag === 'Page' && name === 'bodyWidth' && staticValues(attribute.initializer).includes('narrow') && !isDesignFile(file)) report(attribute, 'single-page-grid', 'Sidebar pages share the full-width Page grid. Bound form rows with oc-form-measure instead.');
        if (name === 'style') report(attribute, 'design-tokens', 'Do not add inline style; use a shared design-system pattern.');
        if (name === 'dangerouslySetInnerHTML') report(attribute, 'react-rendering', 'Render typed React content rather than HTML strings.');
        if (name === 'role' && /^[a-z]/.test(tag)) {
          const roles = staticValues(attribute.initializer).flatMap(value => value.split(/\s+/));
          if (roles.includes('navigation') && tag !== 'nav' && !isNavigationOwner(file)) report(attribute, 'single-navigation', 'Workspace navigation belongs to AppShell; onboarding step navigation belongs to its shell.');
          if (roles.some(role => controlRoles.has(role)) && !rawControls.has(tag) && !isDesignFile(file)) report(attribute, 'shared-controls', 'Use the shared control rather than recreating it with an ARIA role.');
        }
        if (tag === 'a' && name === 'href' && hasInternalPath(attribute.initializer)) report(attribute, 'spa-navigation', 'Use Link for internal navigation.');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (/@ts-(?:ignore|nocheck)/.test(text)) violations.push({file, line: 1, rule: 'strict-types', message: 'Type-check suppression is forbidden.'});
  return violations;
}
