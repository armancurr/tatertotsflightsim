/**
 * Open-source readiness: the files a newcomer (and GitHub) looks for exist and say the right
 * things — package metadata, LICENSE, community files, CI, .gitignore, and a README that
 * documents how to start the game and every key binding in `CONFIG.controls.keys`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { ROOT } from '../support/e2e';
import { fcParams } from '../support/fc';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const pkg = JSON.parse(read('package.json')) as Record<string, unknown> & {
  scripts: Record<string, string>; engines?: { node?: string }; repository?: { type?: string; url?: string } | string;
  bugs?: { url?: string } | string; keywords?: string[]; dependencies: Record<string, string>; devDependencies: Record<string, string>;
};
const readme = read('README.md');

/** Does Node `v` ([major, minor]) satisfy a semver range made of `^a.b.c` / `>=a.b.c` alternatives? */
function satisfies(v: [number, number], range: string): boolean {
  return range.split('||').some((alt) => {
    const m = /(\^|>=)\s*(\d+)\.(\d+)/.exec(alt.trim());
    if (!m) return false;
    const [a, b] = [Number(m[2]), Number(m[3])];
    const atLeast = v[0] > a || (v[0] === a && v[1] >= b);
    return m[1] === '>=' ? atLeast : atLeast && v[0] === a;
  });
}

/** How the README writes a KeyboardEvent.code: the label on the key, inside <kbd>…</kbd>. */
function keyLabel(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return `Numpad ${code.slice(6)}`;
  const named: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Space: 'Space', Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', PageUp: 'Page Up', PageDown: 'Page Down',
    Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete',
    BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/',
    Semicolon: ';', Quote: "'", Backquote: '`', Backslash: '\\',
    NumpadAdd: 'Numpad +', NumpadSubtract: 'Numpad -', NumpadMultiply: 'Numpad *', NumpadDivide: 'Numpad /', NumpadEnter: 'Numpad Enter',
    ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl', AltLeft: 'Alt', AltRight: 'Alt',
  };
  return named[code] ?? code;
}

const allCodes = [...new Set(Object.values(CONFIG.controls.keys as Record<string, readonly string[]>).flat())];

describe('package.json', () => {
  it('is the published Tater\'s Flight Sim package with licence, engines and links', () => {
    expect(pkg.name).toBe('taters-flight-sim');
    expect(pkg.license).toBe('MIT');
    expect(pkg.engines?.node).toMatch(/^>=\s*\d+/);
    expect(String(pkg.description)).toMatch(/Tater's Flight Sim/);
    expect(pkg.keywords?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(pkg.keywords).toEqual(expect.arrayContaining(['flight-simulator', 'threejs', 'webgl2']));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    expect(repo).toMatch(/github\.com\/.+\/taters-flight-sim/);
    expect(String(pkg.homepage)).toMatch(/taters-flight-sim/);
    const bugs = typeof pkg.bugs === 'string' ? pkg.bugs : pkg.bugs?.url;
    expect(bugs).toMatch(/taters-flight-sim\/issues$/);
    expect(pkg.author).toMatch(/Jared Tate/);
  });

  it('has the scripts the README promises; start and preview serve 127.0.0.1:8092', () => {
    for (const s of ['start', 'dev', 'build', 'preview', 'test', 'typecheck', 'check']) expect(pkg.scripts[s], s).toBeTruthy();
    expect(pkg.scripts.start).toMatch(/--port 8092/);
    expect(pkg.scripts.preview).toMatch(/--port 8092/);
    expect(pkg.scripts.test).toBe('vitest run');
  });

  it('.nvmrc pins a Node major that satisfies engines.node', () => {
    const nvm = read('.nvmrc').trim();
    expect(nvm).toMatch(/^\d+$/);
    const floor = Number(/>=\s*(\d+)/.exec(pkg.engines!.node!)![1]);
    expect(Number(nvm)).toBeGreaterThanOrEqual(floor);
  });

  it('the Node floor in engines satisfies what vite and vitest need', () => {
    const m = />=\s*(\d+)(?:\.(\d+))?/.exec(pkg.engines!.node!)!;
    const floor: [number, number] = [Number(m[1]), Number(m[2] ?? 0)];
    for (const dep of ['vitest', 'vite']) {
      const want = (JSON.parse(read(`node_modules/${dep}/package.json`)) as { engines?: { node?: string } }).engines?.node ?? '>=0.0.0';
      expect(satisfies(floor, want), `${dep} engines "${want}" vs ours "${pkg.engines!.node}"`).toBe(true);
    }
  });
});

describe('licence and community files', () => {
  it('LICENSE is MIT, © 2026 Jared Tate', () => {
    const lic = read('LICENSE');
    expect(lic).toMatch(/^MIT License/);
    expect(lic).toContain('Copyright (c) 2026 Jared Tate');
    expect(lic).toContain('Permission is hereby granted, free of charge');
    expect(lic).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
  });

  it('CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, .editorconfig and GitHub templates exist', () => {
    for (const f of ['CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'SECURITY.md', '.editorconfig',
      '.github/PULL_REQUEST_TEMPLATE.md', '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md']) {
      expect(existsSync(join(ROOT, f)), f).toBe(true);
    }
    expect(read('CONTRIBUTING.md')).toMatch(/npm test/);
  });

  it('.gitignore keeps build output, caches, worktrees and scratch screenshots out of git', () => {
    const lines = read('.gitignore').split('\n').map((l) => l.trim());
    // A trailing slash is optional (without it a symlinked node_modules is ignored too).
    for (const want of ['node_modules', 'dist', '.vite', '*.log', '.DS_Store', 'qa/tmp', '.worktrees']) {
      expect(lines.some((l) => l === want || l === `${want}/`), want).toBe(true);
    }
  });
});

describe('CI workflow', () => {
  const ci = read('.github/workflows/ci.yml');
  it('runs on Linux for two Node versions: npm ci → Playwright Chromium → typecheck → test → build → artifact', () => {
    expect(ci).toMatch(/runs-on:\s*ubuntu-latest/);
    expect(ci).toMatch(/node-version:\s*\[\s*\d+\s*,\s*\d+\s*\]/);
    const order = ['npm ci', 'npx playwright install --with-deps chromium', 'npm run typecheck', 'npm test', 'npm run build', 'actions/upload-artifact'];
    let at = -1;
    for (const step of order) {
      const i = ci.indexOf(step);
      expect(i, step).toBeGreaterThan(at);
      at = i;
    }
  });

  it('the Node versions CI tests all satisfy engines.node', () => {
    const versions = /node-version:\s*\[([^\]]+)\]/.exec(ci)![1].split(',').map((v) => Number(v.trim()));
    const floor = Number(/>=\s*(\d+)/.exec(pkg.engines!.node!)![1]);
    for (const v of versions) expect(v).toBeGreaterThanOrEqual(floor);
  });

  it('the optional Pages workflow is manual and builds with a sub-path --base', () => {
    const pages = read('.github/workflows/pages.yml');
    expect(pages).toMatch(/workflow_dispatch/);
    expect(pages).toMatch(/--base[= ]/);
    expect(pages).not.toMatch(/^\s*push:/m);
  });
});

describe('README', () => {
  it('is titled Tater\'s Flight Sim and tells a newcomer how to clone, install, start and open it', () => {
    expect(readme).toMatch(/^# Tater's Flight Sim$/m);
    for (const s of ['git clone', 'npm install', 'npm start', 'http://127.0.0.1:8092', 'npm test', 'npx playwright install chromium', 'npm run build', 'dist/', '--base']) {
      expect(readme, s).toContain(s);
    }
    for (const os of ['macOS', 'Linux', 'Windows']) expect(readme, os).toContain(os);
    expect(readme).toMatch(/Node\.js 2\d/);
  });

  it('names both aircraft and the licence', () => {
    expect(readme).toMatch(/Cessna 172RG/);
    expect(readme).toMatch(/F-16C/);
    expect(readme).toMatch(/\[MIT\]\(LICENSE\)/);
  });

  it('documents every key binding in CONFIG.controls.keys as <kbd>…</kbd>', () => {
    expect(allCodes.length).toBeGreaterThan(20);
    for (const code of allCodes) expect(readme, `${code} → <kbd>${keyLabel(code)}</kbd>`).toContain(`<kbd>${keyLabel(code)}</kbd>`);
    // The jet controls get called out explicitly.
    expect(readme).toMatch(/afterburner/i);
    expect(readme).toMatch(/speed brake/i);
  });

  it('every relative link and image points at a file in the repo', () => {
    const targets = [...readme.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((m) => m[1]).filter((t) => !/^[a-z]+:/i.test(t));
    expect(targets.length).toBeGreaterThan(5);
    for (const t of targets) expect(existsSync(join(ROOT, decodeURI(t))), t).toBe(true);
    // At least one real screenshot of the game (the gallery lives in docs/screenshots).
    expect(readme).toMatch(/!\[[^\]]*\]\(docs\/screenshots\/[^)]+\.(jpg|png)\)/);
  });

  it('keyLabel gives every KeyboardEvent.code a short non-empty label (fuzz)', () => {
    const code = fc.oneof(
      fc.constantFrom(...allCodes),
      fc.integer({ min: 0, max: 25 }).map((i) => `Key${String.fromCharCode(65 + i)}`),
      fc.integer({ min: 0, max: 9 }).map((i) => `Digit${i}`),
      fc.integer({ min: 0, max: 9 }).map((i) => `Numpad${i}`),
      fc.integer({ min: 1, max: 12 }).map((i) => `F${i}`),
    );
    fc.assert(fc.property(code, (c) => {
      const l = keyLabel(c);
      expect(l.length).toBeGreaterThan(0);
      expect(l.length).toBeLessThanOrEqual(14);
      expect(l).not.toMatch(/[<>]/);
    }), fcParams(200));
  });
});
