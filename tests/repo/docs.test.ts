/**
 * The docs stay true to the code. For README, CONTRIBUTING, ARCHITECTURE, ELEVATOR_PITCH and every
 * guide in docs/:
 *   - every relative link resolves to a file in the repository;
 *   - every repository path written in a `code span` (src/…, tests/…, scripts/…, preview/…, docs/…)
 *     exists;
 *   - every `CONFIG.a.b.c` path names a real config value;
 *   - every function (`name()`) or type/constant (`AircraftModelHandle`, `TARGET_KINDS`) named in a
 *     code span appears in the source.
 * Paths and names a guide asks you to create (its worked example) are declared in the guide's
 * `<!-- examples: … -->` comment. Fenced code blocks are not scanned (they are examples to type in).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../../src/config';
import { FLEET } from '../../src/fleet';
import { ROOT } from '../support/e2e';
import { fcParams } from '../support/fc';

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const GUIDES = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
const DOCS = ['README.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md', 'ELEVATOR_PITCH.md', ...GUIDES];

/** The Markdown with fenced code blocks blanked out (line numbers kept). */
export function stripFences(md: string): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** Inline code spans outside fenced blocks. */
export function codeSpans(md: string): string[] {
  return [...stripFences(md).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
}

/** Relative link targets (Markdown links and images) outside code, without #fragments. */
export function relativeLinks(md: string): string[] {
  const text = stripFences(md).replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith('#'))
    .map((t) => decodeURI(t.split('#')[0]));
}

const PATH_ROOTS = /(?:^|[\s(,'"=])((?:src|tests|scripts|preview|docs|\.github)\/[^\s`'",()]*)/g;

/** Repository paths in a code span (placeholders like <name> or globs like * are skipped). */
export function repoPaths(span: string): string[] {
  const out: string[] = [];
  for (const m of span.matchAll(PATH_ROOTS)) {
    const p = m[1].replace(/[.:;]+$/, '').replace(/:\d+(-\d+)?$/, '');
    if (/[<>*{}…$]/.test(p) || p.endsWith('/.')) continue;
    out.push(p);
  }
  return out;
}

/** `CONFIG.a.b` paths (a whole code span, nothing else in it). */
export function configPath(span: string): string[] | null {
  const m = /^CONFIG((?:\.[A-Za-z_$][\w$]*)+)$/.exec(span.trim());
  return m ? m[1].slice(1).split('.') : null;
}

/**
 * Code identifiers a span names: a call `name(…)` (not a method on something), a multi-hump
 * PascalCase type (`AircraftModelHandle`), or an UPPER_CASE constant with an underscore.
 */
export function identifiers(span: string): string[] {
  const s = span.trim();
  const call = /^([A-Za-z_$][\w$]*)\(/.exec(s);
  if (call) return [call[1]];
  if (/^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/.test(s)) return [s];
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(s)) return [s];
  return [];
}

/** Names and paths a guide declares as its worked example (created by the reader). */
export function declaredExamples(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of md.matchAll(/<!--\s*examples:([\s\S]*?)-->/g)) for (const t of m[1].split(/\s+/)) if (t) out.add(t);
  return out;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (/\.(ts|mts|mjs|js|glsl)$/.test(e.name)) out.push(p);
  }
  return out;
}
const CORPUS = ['src', 'scripts', 'tests'].flatMap(listFiles).map(read).join('\n');

const resolveConfig = (keys: string[]): unknown => keys.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), CONFIG);

describe('the docs match the code', () => {
  it('covers README, CONTRIBUTING, ARCHITECTURE, ELEVATOR_PITCH and the guides', () => {
    for (const g of ['docs/ADDING_AN_AIRCRAFT.md', 'docs/ADDING_VEHICLES_AND_TARGETS.md', 'docs/ADDING_BOATS.md', 'docs/ADDING_LAND_FEATURES.md', 'docs/TESTING.md']) {
      expect(DOCS, g).toContain(g);
    }
  });

  for (const doc of DOCS) {
    describe(doc, () => {
      const md = read(doc);
      const examples = declaredExamples(md);
      const spans = codeSpans(md);

      it('every relative link resolves', () => {
        const base = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/') + 1) : '';
        for (const t of relativeLinks(md)) {
          const p = t.startsWith('/') ? t.slice(1) : join(base, t);
          expect(existsSync(join(ROOT, p)), `${doc} → ${t}`).toBe(true);
        }
      });

      it('every repository path in a code span exists', () => {
        const missing = spans.flatMap(repoPaths).filter((p) => !examples.has(p) && !existsSync(join(ROOT, p)));
        expect(missing).toEqual([]);
      });

      it('every CONFIG path names a real config value', () => {
        const bad = spans.map(configPath).filter((k): k is string[] => !!k).filter((k) => resolveConfig(k) === undefined).map((k) => `CONFIG.${k.join('.')}`);
        expect(bad).toEqual([]);
      });

      it('every function, type and constant named in a code span exists in the source', () => {
        const missing = [...new Set(spans.flatMap(identifiers))].filter((n) => !examples.has(n) && !new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(CORPUS));
        expect(missing).toEqual([]);
      });
    });
  }

  it('the example files a guide declares are really examples (not already in the repo)', () => {
    for (const doc of GUIDES) {
      for (const p of declaredExamples(read(doc))) {
        if (/\//.test(p)) expect(existsSync(join(ROOT, p)), `${doc}: ${p} exists — drop it from <!-- examples -->`).toBe(false);
      }
    }
  });

  it('the README names every aircraft in the fleet and every guide', () => {
    const readme = read('README.md');
    for (const d of FLEET) {
      expect(readme, d.name).toContain(d.name);
      expect(readme, `aircraft=${d.id}`).toContain(d.id);
    }
    for (const g of GUIDES) expect(readme, g).toContain(`](${g})`);
  });

  it('the screenshots the README shows exist and stay small', () => {
    const shots = [...read('README.md').matchAll(/!\[[^\]]*\]\((docs\/screenshots\/[^)]+)\)/g)].map((m) => m[1]);
    expect(shots.length).toBeGreaterThanOrEqual(6);
    for (const s of shots) expect(statSync(join(ROOT, s)).size, s).toBeLessThan(2 * 1024 * 1024);
  });
});

describe('the doc scanners themselves', () => {
  it('find paths, links, config paths and identifiers, and skip placeholders and fenced code', () => {
    const md = [
      'See `src/world/layout.ts` and `src/fleet/index.ts:12`, not `src/aircraft/<name>/` or `tests/**/x.ts`.',
      'Read [the guide](docs/TESTING.md#layers), not [the site](https://example.com).',
      '```ts', 'const x = `src/not/scanned.ts`;', '```',
      'Set `CONFIG.world.seed`, call `createLayout()`, implement `AircraftModelHandle` from `TARGET_KINDS`.',
    ].join('\n');
    const spans = codeSpans(md);
    expect(spans.flatMap(repoPaths)).toEqual(['src/world/layout.ts', 'src/fleet/index.ts']);
    expect(relativeLinks(md)).toEqual(['docs/TESTING.md']);
    expect(spans.map(configPath).filter(Boolean)).toEqual([['world', 'seed']]);
    expect(spans.flatMap(identifiers)).toEqual(['createLayout', 'AircraftModelHandle', 'TARGET_KINDS']);
    expect(declaredExamples('<!-- examples: src/a/b.ts makeX -->')).toEqual(new Set(['src/a/b.ts', 'makeX']));
  });

  it('a path in a code span is always found, and never when it sits in a fenced block (fuzz)', () => {
    const seg = fc.stringMatching(/^[a-z][a-zA-Z0-9_-]{0,10}$/);
    const path = fc.tuple(fc.constantFrom('src', 'tests', 'scripts', 'docs'), fc.array(seg, { minLength: 1, maxLength: 4 }), fc.constantFrom('.ts', '.md', '.mjs', ''))
      .map(([root, parts, ext]) => `${root}/${parts.join('/')}${ext}`);
    const prose = fc.stringMatching(/^[A-Za-z ,.]{0,30}$/);
    fc.assert(fc.property(path, prose, prose, fc.boolean(), (p, before, after, fenced) => {
      const md = fenced ? `${before}\n\`\`\`\n\`${p}\`\n\`\`\`\n${after}` : `${before} \`${p}\` ${after}`;
      const found = codeSpans(md).flatMap(repoPaths);
      expect(found).toEqual(fenced ? [] : [p]);
    }), fcParams(300));
  });

  it('identifiers() never returns something that is not a plain identifier (fuzz)', () => {
    fc.assert(fc.property(fc.string({ maxLength: 40 }), (s) => {
      for (const id of identifiers(s)) expect(id).toMatch(/^[A-Za-z_$][\w$]*$/);
    }), fcParams(500));
  });
});
