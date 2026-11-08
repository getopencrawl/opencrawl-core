import ts from 'typescript';

export interface ArchitectureViolation {file: string; line: number; rule: string; message: string}
const rawControls = new Set(['button', 'input', 'select', 'textarea', 'dialog', 'table']);
const isDesignFile = (file: string) => file.startsWith('src/design/');

/** Deliberately small: failures are concrete code ownership rules, not taste scores. */
export function inspectSource(file: string, text: string): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const report = (node: ts.Node, rule: string, message: string) => violations.push({file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, message});
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, 'strict-types', 'Use a concrete type or narrow unknown; explicit any is forbidden.');
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (rawControls.has(tag) && !isDesignFile(file)) report(node, 'shared-controls', `Use the design-system ${tag} wrapper.`);
      if (tag === 'nav' && file !== 'src/app.tsx' && file !== 'src/onboarding/shell.tsx') report(node, 'single-navigation', 'Workspace navigation belongs to AppShell; onboarding step navigation belongs to its shell.');
      for (const attribute of node.attributes.properties) {
        if (!ts.isJsxAttribute(attribute)) continue;
        const name = attribute.name.getText(source);
        if (name === 'style') report(attribute, 'design-tokens', 'Do not add inline style; use a shared design-system pattern.');
        if (name === 'dangerouslySetInnerHTML') report(attribute, 'react-rendering', 'Render typed React content rather than HTML strings.');
        if (tag === 'a' && name === 'href' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && /^\/(?!\/)/.test(attribute.initializer.text)) report(attribute, 'spa-navigation', 'Use Link for internal navigation.');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (/@ts-(?:ignore|nocheck)/.test(text)) violations.push({file, line: 1, rule: 'strict-types', message: 'Type-check suppression is forbidden.'});
  return violations;
}
