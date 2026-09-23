/**
 * The project is MIT-licensed end to end: our code, and everything that ships in the browser
 * bundle (the runtime dependencies and theirs). Dev tools (test runner, types, bundler) are not
 * distributed and may use other permissive licenses.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = join(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { license: string; dependencies?: Record<string, string> };

function licenseOf(name: string): string {
  const p = JSON.parse(readFileSync(join(ROOT, 'node_modules', name, 'package.json'), 'utf8')) as { license?: string; dependencies?: Record<string, string> };
  return String(p.license ?? '');
}

/** Every package that ends up in the browser bundle: runtime dependencies, recursively. */
function runtimeClosure(): string[] {
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const file = join(ROOT, 'node_modules', name, 'package.json');
    if (!existsSync(file)) return;
    const p = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> };
    for (const d of Object.keys(p.dependencies ?? {})) walk(d);
  };
  for (const d of Object.keys(pkg.dependencies ?? {})) walk(d);
  return [...seen];
}

describe('MIT license', () => {
  it('LICENSE is the MIT license, copyright Jared Tate; package.json says MIT', () => {
    const text = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
    expect(text).toMatch(/^MIT License/);
    expect(text).toMatch(/Copyright \(c\) 20\d\d Jared Tate/);
    expect(text).toMatch(/Permission is hereby granted, free of charge/);
    expect(pkg.license).toBe('MIT');
  });

  it('everything that ships in the bundle is MIT', () => {
    const closure = runtimeClosure();
    expect(closure).toContain('three');
    for (const name of closure) expect(licenseOf(name), name).toBe('MIT');
  });

  it('no tracked source file carries a different license header', () => {
    const files = execSync('git ls-files src scripts index.html', { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8');
      expect(text, f).not.toMatch(/SPDX-License-Identifier:\s*(?!MIT\b)/);
      expect(text, f).not.toMatch(/GNU (General|Lesser) Public License|Apache License, Version|Creative Commons/);
    }
  });

  it('the README says MIT', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(readme).toMatch(/## License[\s\S]*MIT/);
  });
});
