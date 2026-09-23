/** Types for scripts/test-browser.mjs (see that file for the resolution order). */

/** What the resolver may look at: injectable so the tests can fake any machine. */
export interface BrowserProbe {
  env: Record<string, string | undefined>;
  platform: string;
  home: string;
  exists(path: string): boolean;
  list(dir: string): string[];
}

export interface ResolvedBrowser {
  /** undefined → Playwright's own bundled Chromium. */
  executablePath: string | undefined;
  source: 'TEST_BROWSER' | 'chrome-for-testing' | 'playwright';
}

export interface TestLaunchOptions {
  headless: true;
  args: string[];
  executablePath?: string;
}

export function systemProbe(): BrowserProbe;
export function resolveTestBrowser(probe?: BrowserProbe): ResolvedBrowser;
export function browserArgs(platform?: string, softwareGl?: boolean): string[];
export function wantsSoftwareGl(env?: Record<string, string | undefined>): boolean;
export function launchOptions(extraArgs?: string[], probe?: BrowserProbe): TestLaunchOptions;
export function isSoftwareRenderer(renderer: string | null | undefined): boolean;
