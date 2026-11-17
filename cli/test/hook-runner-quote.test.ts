import {test, expect} from 'bun:test';
import {literal, quote, commandQuote, powershellQuote} from '../src/hook-runner.ts';

const value = 'C:\\profile %TEMP% "a" it\'s';
function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', {...original, value: platform});
  try {return run();} finally {Object.defineProperty(process, 'platform', original);}
}

test('runner script words double a percent for cmd batch text and single-quote for sh', () => {
  expect(literal(value, true)).toBe('"C:\\profile %%TEMP%% ""a"" it\'s"');
  expect(literal(value, false)).toBe("'C:\\profile %TEMP% \"a\" it'\\''s'");
  expect(onPlatform('win32', () => quote(value))).toBe(literal(value, true));
  expect(onPlatform('linux', () => quote(value))).toBe(literal(value, false));
});

test('hook command line words keep a percent single on Windows', () => {
  expect(onPlatform('win32', () => commandQuote(value))).toBe('"C:\\profile %TEMP% ""a"" it\'s"');
  expect(onPlatform('linux', () => commandQuote(value))).toBe(literal(value, false));
});

test('PowerShell words double an embedded single quote and leave the rest literal', () => {
  expect(powershellQuote(value)).toBe("'C:\\profile %TEMP% \"a\" it''s'");
});
