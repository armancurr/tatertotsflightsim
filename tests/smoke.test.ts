import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { CONFIG, cloneConfig } from '../src/config';

describe('smoke', () => {
  it('serves a page titled "Flight Simulator"', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/<title>Flight Simulator<\/title>/);
    expect(html).toMatch(/src\/main\.ts/);
  });
  it('npm start serves on port 8092 and npm test runs vitest', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.start).toMatch(/--port 8092/);
    expect(pkg.scripts.test).toMatch(/vitest run/);
    expect(pkg.dependencies.three).toBeTruthy();
  });
  it('has one config with the physics time step and the aircraft', () => {
    expect(CONFIG.sim.fixedDt).toBeCloseTo(1 / 120);
    expect(CONFIG.aircraft.mass).toBeGreaterThan(500);
    const c = cloneConfig();
    c.aircraft.mass = 1;
    expect(CONFIG.aircraft.mass).not.toBe(1);
  });
  it('has the main entry module', () => {
    expect(existsSync(new URL('../src/main.ts', import.meta.url))).toBe(true);
  });
});
