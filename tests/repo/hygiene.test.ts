/**
 * Publishing hygiene over every tracked text file: no absolute paths from someone's machine,
 * no credentials, no personal e-mail addresses, and the committed screenshots stay small enough
 * that a clone is quick.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../support/e2e';
import { fcParams } from '../support/fc';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.worktrees', '.vite', 'coverage']);
const TEXT = /\.(ts|mts|mjs|js|json|md|html|css|yml|yaml|svg|txt|glsl)$|^(LICENSE|\.gitignore|\.nvmrc|\.editorconfig)$/;

/** Tracked files (git ls-files), or — outside a git checkout, e.g. a downloaded zip — a walk of the tree. */
function repoFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name) && relative(ROOT, join(dir, e.name)) !== join('qa', 'tmp')) walk(join(dir, e.name));
        } else out.push(relative(ROOT, join(dir, e.name)).split('\\').join('/'));
      }
    };
    walk(ROOT);
    return out;
  }
}

const files = repoFiles();
const textFiles = files.filter((f) => TEXT.test(f.split('/').pop()!) && f !== 'package-lock.json');
const contents = new Map(textFiles.map((f) => {
  try { return [f, readFileSync(join(ROOT, f), 'utf8')] as const; } catch { return [f, ''] as const; } // deleted in the working tree
}));

// Built from pieces so this file does not match its own patterns.
const HOME = ['/Us', 'ers/'].join('');
/** An absolute path inside someone's home directory or the OS temp tree. */
const PERSONAL_PATH = new RegExp(
  [`${HOME}(?!<)[A-Za-z0-9._-]+/`, '/home/(?!runner/|<)[A-Za-z0-9._-]+/', '[A-Z]:\\\\Users\\\\[^\\\\<]+\\\\', '/priv' + 'ate/(?:tmp|var)/', 'scratch' + 'pad'].join('|'),
);
/** Credential shapes worth refusing outright. */
const SECRET = new RegExp([
  'sbp_[A-Za-z0-9]{20,}', 'gh[pousr]_[A-Za-z0-9]{30,}', 'github_pat_[A-Za-z0-9_]{30,}', 'sk-[A-Za-z0-9_-]{24,}', 'sk-ant-[A-Za-z0-9_-]{20,}',
  'AKIA[0-9A-Z]{16}', 'AIza[0-9A-Za-z_-]{35}', 'xox[baprs]-[A-Za-z0-9-]{10,}', '-----BEGIN [A-Z ]*PRIVATE KEY-----',
  '(?:api[_-]?key|secret|password|passwd|token)\\s*[:=]\\s*[\'"][^\'"\\s]{12,}[\'"]',
].join('|'), 'i');
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Addresses that are fine to publish: bot/no-reply identities and example domains. */
const EMAIL_OK = /(^noreply@anthropic\.com$|@users\.noreply\.github\.com$|@example\.(com|org)$)/i;

/**
 * Files the orchestrator rewrites at publish time (the agents may not edit them). Remove an entry
 * once that file is scrubbed — the test then guards it too.
 */
const PENDING_SCRUB = new Set<string>([]);
/** This file holds sample bad paths and fake credentials to test the detectors, so it skips the scans. */
const SELF = 'tests/repo/hygiene.test.ts';

describe('publishing hygiene (tracked text files)', () => {
  it('finds the repository files', () => {
    expect(textFiles.length).toBeGreaterThan(100);
    expect(textFiles).toContain('README.md');
  });

  it('no absolute paths from a personal machine (home dirs, OS temp, agent scratch folders)', () => {
    const hits: string[] = [];
    for (const [f, text] of contents) {
      if (PENDING_SCRUB.has(f) || f === SELF) continue;
      text.split('\n').forEach((line, i) => { if (PERSONAL_PATH.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); });
    }
    expect(hits).toEqual([]);
  });

  it('no credentials or tokens', () => {
    const hits: string[] = [];
    for (const [f, text] of contents) {
      if (f === SELF) continue;
      text.split('\n').forEach((line, i) => { if (SECRET.test(line)) hits.push(`${f}:${i + 1}`); });
    }
    expect(hits).toEqual([]);
  });

  it('no personal e-mail addresses (only no-reply and example.com ones)', () => {
    const hits: string[] = [];
    for (const [f, text] of contents) {
      if (f === SELF) continue;
      for (const m of text.matchAll(EMAIL)) {
        // Skip things like "three@0.186.0" or "@types/node@26" (package@version), not addresses.
        if (/@\d/.test(m[0]) || /\.(png|svg|ts|js|mjs|json)$/i.test(m[0])) continue;
        if (!EMAIL_OK.test(m[0])) hits.push(`${f}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('committed screenshots stay under 40 MB in total and 3 MB each', () => {
    const shots = files.filter((f) => f.startsWith('qa/screenshots/') && f.endsWith('.png'));
    const sizes = shots.map((f) => { try { return statSync(join(ROOT, f)).size; } catch { return 0; } });
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThan(40 * 1024 * 1024);
    for (let i = 0; i < shots.length; i++) expect(sizes[i], shots[i]).toBeLessThan(3 * 1024 * 1024);
  });
});

describe('the detectors themselves', () => {
  it('flag personal paths and pass repo-relative and placeholder ones', () => {
    for (const bad of [`${HOME}jt/Code/x`, '/home/alice/src/x', 'C:\\Users\\bob\\x', '/priv' + 'ate/tmp/claude-1/x', 'see the session scratch' + 'pad']) expect(PERSONAL_PATH.test(bad), bad).toBe(true);
    for (const ok of ['src/config.ts', '~/Library/Caches/ms-playwright', '/home/runner/work/x', `${HOME}<you>/x`, '/Applications/Google Chrome.app', 'os.tmpdir()']) expect(PERSONAL_PATH.test(ok), ok).toBe(false);
  });

  it('flag credential shapes but not ordinary code', () => {
    for (const bad of ['sbp_' + 'a'.repeat(30), 'ghp_' + 'b'.repeat(36), 'AKIA' + 'C'.repeat(16), 'password = "hunter2hunter2"', '-----BEGIN RSA PRIVATE KEY-----']) {
      expect(SECRET.test(bad), bad).toBe(true);
    }
    for (const ok of ['const token = {};', 'instances.add(token);', 'apiKey: string', 'secret sauce']) expect(SECRET.test(ok), ok).toBe(false);
  });

  it('a random home-directory path is always caught, wherever it sits in a line (fuzz)', () => {
    const seg = fc.stringMatching(/^[A-Za-z0-9._-]{1,12}$/);
    fc.assert(fc.property(fc.string({ maxLength: 20 }), seg, seg, fc.constantFrom(HOME, '/home/'), (prefix, user, rest, root) => {
      fc.pre(!(root === '/home/' && user === 'runner'));
      expect(PERSONAL_PATH.test(`${prefix}${root}${user}/${rest}`)).toBe(true);
    }), fcParams(300));
  });
});
