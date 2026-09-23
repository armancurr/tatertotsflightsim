// @vitest-environment happy-dom
/**
 * Aircraft picker (upper-right dropdown) and the saved-choice helpers: open/close by mouse and
 * keyboard, choosing calls onSelect, keys inside the widget never reach the sim, localStorage
 * restore rules (URL wins; unknown ids and broken storage are ignored).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { createAircraftPicker, aircraftToRestore, saveAircraftChoice, loadAircraftChoice, type PickerItem } from '../../src/ui/picker';

const FLEET: PickerItem[] = [
  { id: 'c172rg', name: 'Cessna 172RG Cutlass', shortName: 'Cessna 172', description: 'Four-seat piston trainer.' },
  { id: 'f16', name: 'F-16C Fighting Falcon', shortName: 'F-16', description: 'Supersonic fighter.' },
];

const key = (el: Element, code: string, k = code) => {
  const e = new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = '';
});

function make(current = 'c172rg') {
  const onSelect = vi.fn();
  const p = createAircraftPicker(document, { items: FLEET, current, onSelect });
  document.body.appendChild(p.element);
  dispose = p.dispose;
  const button = p.element.querySelector('button.tfs-picker-button') as HTMLButtonElement;
  const list = p.element.querySelector('[role="listbox"]') as HTMLElement;
  return { p, onSelect, button, list, options: () => [...list.querySelectorAll('[role="option"]')] as HTMLElement[] };
}

describe('aircraft picker widget', () => {
  it('shows the current aircraft and lists every fleet entry with its description', () => {
    const { button, list, options } = make();
    expect(button.textContent).toContain('Cessna 172');
    expect(button.getAttribute('aria-haspopup')).toBe('listbox');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('Four-seat piston trainer.'), expect.stringContaining('Supersonic fighter.')]);
    expect(options()[0].getAttribute('aria-selected')).toBe('true');
  });

  it('a click opens it; choosing another aircraft calls onSelect and closes it', () => {
    const { p, button, list, options, onSelect } = make();
    button.click();
    expect(list.hidden).toBe(false);
    expect(p.isOpen()).toBe(true);
    options()[1].click();
    expect(onSelect).toHaveBeenCalledWith('f16');
    expect(list.hidden).toBe(true);
  });

  it('choosing the current aircraft just closes it', () => {
    const { button, options, onSelect, list } = make();
    button.click();
    options()[0].click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(list.hidden).toBe(true);
  });

  it('keyboard: Enter/ArrowDown open, arrows move, Enter picks, Escape closes — and no key leaks to the sim', () => {
    const { button, list, onSelect } = make();
    const leaked: string[] = [];
    const spy = (e: KeyboardEvent) => leaked.push(e.code);
    window.addEventListener('keydown', spy);
    key(button, 'ArrowDown');
    expect(list.hidden).toBe(false);
    key(list, 'ArrowDown');
    key(list, 'Enter');
    expect(onSelect).toHaveBeenCalledWith('f16');
    key(button, 'Enter');
    expect(list.hidden).toBe(false);
    key(list, 'Escape');
    expect(list.hidden).toBe(true);
    window.removeEventListener('keydown', spy);
    expect(leaked).toEqual([]);
  });

  it('with the list closed, flying keys pass through to the sim (the button does not steal arrows or Space)', () => {
    const { button, list } = make();
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.code);
    window.addEventListener('keydown', spy);
    key(button, 'Space', ' ');
    key(button, 'ArrowLeft');
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual(['Space', 'ArrowLeft']);
    expect(list.hidden).toBe(true);
  });

  it('a click outside closes it; setCurrent updates the label and the selection', () => {
    const { p, button, list, options } = make();
    button.click();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(list.hidden).toBe(true);
    p.setCurrent('f16');
    expect(button.textContent).toContain('F-16');
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    expect(options()[0].getAttribute('aria-selected')).toBe('false');
  });

  it('takes pointer events only on the widget itself', () => {
    const { p } = make();
    expect(p.element.style.pointerEvents).toBe('auto');
  });
});

describe('saved aircraft choice', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  const ids = FLEET.map((f) => f.id);

  it('round-trips through storage', () => {
    const s = store();
    saveAircraftChoice(s, 'k', 'f16');
    expect(loadAircraftChoice(s, 'k')).toBe('f16');
  });

  it('restores a saved, known, different aircraft when the URL does not name one', () => {
    const s = store();
    saveAircraftChoice(s, 'k', 'f16');
    expect(aircraftToRestore('', s, 'k', ids, 'c172rg')).toBe('f16');
    expect(aircraftToRestore('?veil=0', s, 'k', ids, 'c172rg')).toBe('f16');
  });

  it('the URL wins; the current aircraft, unknown ids and missing storage restore nothing', () => {
    const s = store();
    saveAircraftChoice(s, 'k', 'f16');
    expect(aircraftToRestore('?aircraft=c172rg', s, 'k', ids, 'c172rg')).toBeNull();
    expect(aircraftToRestore('', s, 'k', ids, 'f16')).toBeNull();
    saveAircraftChoice(s, 'k', 'b747');
    expect(aircraftToRestore('', s, 'k', ids, 'c172rg')).toBeNull();
    expect(aircraftToRestore('', null, 'k', ids, 'c172rg')).toBeNull();
  });

  it('property: storage that throws never breaks anything', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (search, id) => {
        const bad = {
          getItem: () => {
            throw new Error('SecurityError');
          },
          setItem: () => {
            throw new Error('QuotaExceeded');
          },
        };
        expect(() => saveAircraftChoice(bad, 'k', id)).not.toThrow();
        expect(loadAircraftChoice(bad, 'k')).toBeNull();
        expect(aircraftToRestore(search, bad, 'k', ids, 'c172rg')).toBeNull();
      }),
      { numRuns: 50 },
    );
  });
});
