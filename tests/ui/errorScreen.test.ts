// @vitest-environment happy-dom
/**
 * Error screens (src/ui/veil.ts): what a stranger sees when the simulator can't run — a friendly card
 * with what to try, never a blank page. Content builders are pure; the DOM card is text-only.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  browserFamily, createLoadingVeil, showErrorScreen, showNotice, startupErrorContent, veilActive, webglErrorContent,
} from '../../src/ui/veil';
import { fcParams } from '../support/fc';

const UA = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:140.0) Gecko/20100101 Firefox/140.0',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};

afterEach(() => {
  document.body.innerHTML = '';
  document.head.innerHTML = '';
});

describe('error content (pure)', () => {
  it('recognises the browser family from the user agent', () => {
    expect(browserFamily(UA.chrome)).toBe('chrome');
    expect(browserFamily(UA.edge)).toBe('edge');
    expect(browserFamily(UA.firefox)).toBe('firefox');
    expect(browserFamily(UA.safari)).toBe('safari');
    expect(browserFamily('')).toBe('other');
  });

  it('no WebGL 2: says so plainly, suggests updating / another browser, with the right acceleration setting', () => {
    const c = webglErrorContent('no-webgl2', UA.firefox);
    expect(c.title).toMatch(/3D/);
    expect(c.message).toMatch(/WebGL 2/);
    expect(c.tips.join(' ')).toMatch(/Firefox Settings/);
    expect(c.tips.join(' ')).toMatch(/another browser/i);
    expect(c.reload).toBe(false);
    expect(webglErrorContent('webgl1-only', UA.chrome).message).toMatch(/WebGL 1/);
    expect(webglErrorContent('no-webgl2', UA.safari).tips.join(' ')).toMatch(/Safari 15/);
  });

  it('context creation failed: points at hardware acceleration and offers a reload', () => {
    const c = webglErrorContent('context-failed', UA.chrome);
    expect(c.tips.join(' ')).toMatch(/graphics acceleration/);
    expect(c.reload).toBe(true);
  });

  it('a failed chunk download is a "reload" problem, not a crash report', () => {
    const c = startupErrorContent(new TypeError('Failed to fetch dynamically imported module: https://x/assets/app-1.js'));
    expect(c.title).toMatch(/didn't finish loading/);
    expect(c.reload).toBe(true);
    expect(c.tips[0]).toMatch(/Reload/);
  });

  it('any other start-up error: a friendly title plus the technical details for an issue', () => {
    const e = new RangeError('boom at the systems');
    const c = startupErrorContent(e);
    expect(c.title).toMatch(/went wrong/);
    expect(c.details).toContain('boom at the systems');
    expect(c.reload).toBe(true);
  });

  it('property: never throws and always has a title, message and bounded details, whatever was thrown', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), (thrown, ua) => {
        const c = startupErrorContent(thrown, ua);
        expect(c.title.length).toBeGreaterThan(5);
        expect(c.message.length).toBeGreaterThan(5);
        expect((c.details ?? '').length).toBeLessThanOrEqual(4000);
      }),
      fcParams(200),
    );
  });
});

describe('error screen (DOM)', () => {
  it('draws a card with title, tips, reload and collapsed details — as text, never HTML', () => {
    const el = showErrorScreen(document, {
      title: 'Title <b>x</b>', message: 'Msg <img src=x onerror=alert(1)>', tips: ['one', 'two'], details: 'stack <script>', reload: true,
    });
    expect(el.getAttribute('role')).toBe('alert');
    expect(el.querySelector('.fse-title')!.textContent).toBe('Title <b>x</b>');
    expect(el.querySelector('.fse-message img')).toBeNull();
    expect(el.querySelectorAll('.fse-tips li')).toHaveLength(2);
    expect(el.querySelector('button.fse-reload')).not.toBeNull();
    expect(el.querySelector('details pre')!.textContent).toBe('stack <script>');
    expect(el.querySelector('script')).toBeNull();
  });

  it('replaces the loading veil (and a previous error card) instead of stacking on it', () => {
    createLoadingVeil(document);
    expect(veilActive()).toBe(true);
    showErrorScreen(document, webglErrorContent('no-webgl2'));
    showErrorScreen(document, startupErrorContent(new Error('x')));
    expect(veilActive()).toBe(false);
    expect(document.querySelector('.fsv-veil')).toBeNull();
    expect(document.querySelectorAll('.fse-screen')).toHaveLength(1);
  });

  it('a notice banner can change its text, carries an action button and removes itself', () => {
    let clicked = 0;
    const n = showNotice(document, 'Restoring…', { label: 'Reload', onClick: () => clicked++ });
    expect(n.element.textContent).toContain('Restoring…');
    n.setText('Could not restore');
    expect(n.element.textContent).toContain('Could not restore');
    (n.element.querySelector('button') as HTMLButtonElement).click();
    expect(clicked).toBe(1);
    n.remove();
    expect(document.querySelector('.fse-notice')).toBeNull();
  });
});
