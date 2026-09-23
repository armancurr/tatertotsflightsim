/**
 * Boeing 747-400 flight deck — the painted panel faces (one 2048² atlas + a matching glow atlas for
 * the panel backlighting at dusk and the lit annunciators): the overhead panel (IRS, ELEC, HYD, FIRE,
 * FUEL, ANTI-ICE, START, AIR, BLEED, LIGHTS…), the MCP and EFIS panels on the glareshield, the main
 * panel face, the three CDUs, the throttle quadrant plate with the flap gate, the aft pedestal radio
 * panels, the side consoles and the circuit-breaker panel.
 *
 * The overhead and MCP are data (`overheadItems`, `MCP_KNOBS`): the painter draws their legends and
 * outlines, flightDeckGeom.ts stands a switch, knob, button or fire handle on each — the paint and the
 * relief always line up. All procedural; system fonts only.
 */
type Ctx = CanvasRenderingContext2D;

export const ATLAS_SIZE = 2048;
export interface ARect {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Atlas regions, px (y down). */
export const ATLAS: Record<string, ARect> = {
  overhead: { x: 0, y: 0, w: 1024, h: 1168 },
  mcp: { x: 1024, y: 0, w: 1024, h: 104 },
  efisL: { x: 1024, y: 112, w: 616, h: 104 },
  efisR: { x: 1024, y: 216, w: 616, h: 104 },
  cdu0: { x: 1024, y: 328, w: 256, h: 400 },
  cdu1: { x: 1280, y: 328, w: 256, h: 400 },
  cdu2: { x: 1536, y: 328, w: 256, h: 400 },
  consoleL: { x: 1792, y: 328, w: 128, h: 560 },
  consoleR: { x: 1920, y: 328, w: 128, h: 560 },
  quadrant: { x: 1024, y: 736, w: 384, h: 256 },
  pedestalAft: { x: 1408, y: 736, w: 384, h: 432 },
  cb: { x: 1024, y: 1000, w: 384, h: 168 },
  main: { x: 0, y: 1176, w: 2048, h: 520 },
  aftWall: { x: 0, y: 1704, w: 1024, h: 344 },
};
/** UV rect (three.js: v up) of an atlas region. */
export function atlasUV(r: ARect): { u0: number; v0: number; u1: number; v1: number } {
  return { u0: r.x / ATLAS_SIZE, u1: (r.x + r.w) / ATLAS_SIZE, v0: 1 - (r.y + r.h) / ATLAS_SIZE, v1: 1 - r.y / ATLAS_SIZE };
}

export type ItemKind = 'toggle' | 'rotary' | 'push' | 'handle' | 'guard';
export interface PanelItem {
  kind: ItemKind;
  /** Panel coordinates 0..1 (u across from the left, v from the front/top edge). */
  u: number;
  v: number;
  label: string;
  /** Push buttons: lit legend in the glow atlas (annunciator on). */
  lit?: string;
  litColor?: string;
}
export interface PanelGroup {
  title: string;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

/** The overhead panel: groups (outlined, titled) and their items. Built once. */
export function overheadItems(): { groups: PanelGroup[]; items: PanelItem[] } {
  const groups: PanelGroup[] = [];
  const items: PanelItem[] = [];
  const row = (title: string, u0: number, u1: number, v0: number, v1: number, kind: ItemKind, labels: string[], lit?: (i: number) => string | undefined, litColor?: string) => {
    groups.push({ title, u0, v0, u1, v1 });
    const n = labels.length;
    for (let i = 0; i < n; i++) {
      const u = u0 + ((u1 - u0) * (i + 0.5)) / n;
      items.push({ kind, u, v: v0 + (v1 - v0) * 0.4, label: labels[i], lit: lit?.(i), litColor });
    }
  };
  const eng = ['1', '2', '3', '4'];
  // Row 0: IRS, ELEC, HYD.
  row('IRS', 0.03, 0.3, 0.02, 0.13, 'rotary', ['L', 'C', 'R']);
  row('ELECTRICAL — GEN CONT', 0.33, 0.67, 0.02, 0.13, 'push', eng, () => undefined);
  row('HYDRAULIC — DEMAND PUMP', 0.7, 0.97, 0.02, 0.13, 'rotary', eng);
  // Row 1: bus ties, fire handles, APU.
  row('BUS TIE', 0.03, 0.3, 0.15, 0.26, 'push', eng);
  row('ENGINE FIRE', 0.33, 0.67, 0.15, 0.3, 'handle', eng);
  row('APU', 0.7, 0.83, 0.15, 0.26, 'rotary', ['APU']);
  row('CARGO FIRE', 0.85, 0.97, 0.15, 0.26, 'guard', ['FWD', 'AFT']);
  // Row 2: the fuel panel (pumps and crossfeed valves; blue VALVE lights while a valve moves… off here).
  row('FUEL — X FEED', 0.03, 0.97, 0.32, 0.4, 'rotary', ['1', '2', '3', '4']);
  row('FUEL — MAIN PUMPS FWD', 0.03, 0.97, 0.41, 0.49, 'push', ['1', '2', 'CTR L', 'CTR R', '3', '4']);
  row('FUEL — MAIN PUMPS AFT', 0.03, 0.97, 0.5, 0.58, 'push', ['1', '2', 'OVRD', 'OVRD', '3', '4']);
  // Row 3: anti-ice, window heat, engine start, ignition.
  row('NACELLE ANTI-ICE', 0.03, 0.3, 0.6, 0.7, 'push', eng);
  row('WINDOW HEAT', 0.33, 0.55, 0.6, 0.7, 'push', ['L', 'L', 'R', 'R']);
  row('ENGINE START', 0.58, 0.97, 0.6, 0.7, 'push', eng, () => undefined);
  // Row 4: packs, bleeds, pressurisation.
  row('PACKS', 0.03, 0.3, 0.72, 0.82, 'rotary', ['1', '2', '3']);
  row('ENGINE BLEED', 0.33, 0.67, 0.72, 0.82, 'push', eng);
  row('CABIN ALT', 0.7, 0.97, 0.72, 0.82, 'rotary', ['LDG ALT', 'MODE']);
  // Row 5: lights, wipers, signs.
  row('LANDING LIGHTS', 0.03, 0.4, 0.84, 0.95, 'toggle', ['OUTBD L', 'INBD L', 'INBD R', 'OUTBD R']);
  row('LIGHTS', 0.43, 0.8, 0.84, 0.95, 'toggle', ['RWY L', 'TAXI', 'BEACON', 'NAV', 'STROBE', 'WING']);
  row('SIGNS', 0.83, 0.97, 0.84, 0.95, 'rotary', ['SEAT BELTS']);
  return { groups, items };
}

/** MCP knobs along the glareshield (u 0..1 across the MCP), and the V/S thumbwheel. */
export const MCP_KNOBS: readonly { u: number; label: string; window: string; value: string }[] = [
  { u: 0.2, label: 'IAS/MACH', window: 'IAS', value: '' },
  { u: 0.44, label: 'HEADING', window: 'HDG', value: '' },
  { u: 0.64, label: 'ALTITUDE', window: 'ALT', value: '' },
  { u: 0.8, label: 'VERT SPD', window: 'V/S', value: '' },
];
/** EFIS control panel knobs (u across its panel). */
export const EFIS_KNOBS: readonly number[] = [0.28, 0.5];

export type PaintMode = 'albedo' | 'glow';

const PANEL = '#5d6368';
const PANEL_EDGE = '#484d51';
const LEGEND = '#f2f2ea';
const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif';

function txt(c: Ctx, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = 'center', weight = 700) {
  c.font = `${weight} ${Math.max(5, Math.round(size))}px ${FONT}`;
  c.fillStyle = color;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillText(s, x, y);
}

/** Paint the whole atlas: 'albedo' = the panels as seen by day, 'glow' = backlit legends and lit lights on black. */
export function paintDeckAtlas(c: Ctx, mode: PaintMode): void {
  const glow = mode === 'glow';
  c.save();
  c.fillStyle = glow ? '#000' : PANEL;
  c.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  const legend = glow ? '#fff4dc' : LEGEND;
  // A sub-panel: grey plate with a darker seam and four screws (albedo only).
  const plate = (x: number, y: number, w: number, h: number, fill = PANEL) => {
    if (glow) return;
    c.fillStyle = fill;
    c.fillRect(x, y, w, h);
    c.strokeStyle = PANEL_EDGE;
    c.lineWidth = 2;
    c.strokeRect(x + 1, y + 1, w - 2, h - 2);
    c.fillStyle = '#3d4145';
    for (const [sx, sy] of [[x + 5, y + 5], [x + w - 5, y + 5], [x + 5, y + h - 5], [x + w - 5, y + h - 5]]) {
      c.beginPath();
      c.arc(sx, sy, 2, 0, Math.PI * 2);
      c.fill();
    }
  };
  const annunciator = (x: number, y: number, w: number, h: number, label: string, lit: string | undefined, color: string) => {
    if (glow) {
      if (lit) txt(c, lit, x + w / 2, y + h / 2, h * 0.5, color);
      return;
    }
    c.fillStyle = '#1b1d1f';
    c.fillRect(x, y, w, h);
    c.strokeStyle = '#8a8f93';
    c.lineWidth = 1.5;
    c.strokeRect(x, y, w, h);
    txt(c, label, x + w / 2, y + h / 2, h * 0.42, '#6a6e70');
  };

  // ── Overhead ──
  {
    const R = ATLAS.overhead;
    plate(R.x, R.y, R.w, R.h, '#5a6065');
    const { groups, items } = overheadItems();
    // v runs from the front edge (image bottom) to the aft edge (image top).
    for (const g of groups) {
      const x = R.x + g.u0 * R.w;
      const y = R.y + (1 - g.v1) * R.h;
      const w = (g.u1 - g.u0) * R.w;
      const h = (g.v1 - g.v0) * R.h;
      plate(x, y, w, h);
      c.strokeStyle = legend;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(x + 6, y + 14);
      c.lineTo(x + w - 6, y + 14);
      c.stroke();
      txt(c, g.title, x + w / 2, y + 14, 12, legend);
      if (!glow) {
        c.fillStyle = PANEL;
        const tw = Math.min(w - 16, g.title.length * 8 + 12);
        c.fillRect(x + w / 2 - tw / 2, y + 7, tw, 14);
        txt(c, g.title, x + w / 2, y + 14, 12, legend);
      }
    }
    for (const it of items) {
      const x = R.x + it.u * R.w;
      const y = R.y + (1 - it.v) * R.h;
      txt(c, it.label, x, y - 30, 11, legend);
      if (it.kind === 'push') annunciator(x - 22, y - 18, 44, 36, it.label.length > 3 ? 'ON' : 'OFF', it.lit, it.litColor ?? '#ffb000');
      else if (it.kind === 'rotary' && !glow) {
        c.strokeStyle = legend;
        c.lineWidth = 2;
        for (let k = -2; k <= 2; k++) {
          const a = -Math.PI / 2 + k * 0.5;
          c.beginPath();
          c.moveTo(x + Math.cos(a) * 20, y + Math.sin(a) * 20);
          c.lineTo(x + Math.cos(a) * 26, y + Math.sin(a) * 26);
          c.stroke();
        }
      } else if (it.kind === 'handle' && !glow) {
        c.fillStyle = '#26282a';
        c.fillRect(x - 34, y - 14, 68, 28);
        txt(c, 'PULL', x, y + 26, 10, '#d0402a');
      } else if (it.kind === 'guard' && !glow) {
        c.strokeStyle = '#c23b2b';
        c.lineWidth = 3;
        c.strokeRect(x - 18, y - 16, 36, 32);
      } else if (it.kind === 'toggle') txt(c, 'ON', x, y + 24, 10, legend);
    }
  }

  // ── MCP and EFIS panels ──
  {
    const R = ATLAS.mcp;
    plate(R.x, R.y, R.w, R.h, '#565c61');
    // Autopilot engage buttons, A/T ARM, modes.
    const modes = ['A/T ARM', 'N1', 'SPD', 'LNAV', 'VNAV', 'FL CH', 'HDG HOLD', 'V/S', 'ALT HOLD', 'LOC', 'APP'];
    const mx = [0.03, 0.08, 0.13, 0.3, 0.35, 0.53, 0.5, 0.87, 0.72, 0.9, 0.95];
    modes.forEach((m, i) => {
      const x = R.x + mx[i] * R.w;
      if (!glow) {
        c.fillStyle = '#2a2c2e';
        c.fillRect(x - 20, R.y + 52, 40, 30);
      }
      txt(c, m, x, R.y + 40, 9, legend);
      if (!glow) {
        c.fillStyle = '#5e6a58';
        c.fillRect(x - 8, R.y + 72, 16, 4);
      }
    });
    for (const k of MCP_KNOBS) {
      const x = R.x + k.u * R.w;
      txt(c, k.label, x, R.y + 12, 10, legend);
      // Display window above the knob (digits lit in both atlases: they are LCD/LED windows).
      c.fillStyle = '#0b0c0c';
      c.fillRect(x - 40, R.y + 20, 80, 26);
      const val = k.window === 'IAS' ? '160' : k.window === 'HDG' ? '360' : k.window === 'ALT' ? '5000' : '';
      txt(c, val, x, R.y + 33, 20, glow ? '#ffd9a0' : '#e8c890', 'center', 600);
    }
    const cmd = ['CMD L', 'CMD C', 'CMD R'];
    cmd.forEach((m, i) => {
      const x = R.x + (0.97 - 0.035 * (2 - i)) * R.w - 20;
      txt(c, m, x, R.y + 92, 8, legend);
    });
    for (const [key, side] of [['efisL', -1], ['efisR', 1]] as const) {
      const E = ATLAS[key];
      plate(E.x, E.y, E.w, E.h);
      txt(c, 'EFIS', E.x + E.w * 0.08, E.y + 14, 11, legend);
      const labels = ['MODE', 'RANGE'];
      labels.forEach((l, i) => txt(c, l, E.x + E.w * EFIS_KNOBS[i], E.y + 14, 10, legend));
      const btn = ['WXR', 'STA', 'WPT', 'ARPT', 'DATA', 'POS'];
      btn.forEach((b, i) => {
        const x = E.x + E.w * (0.6 + i * 0.045);
        if (!glow) {
          c.fillStyle = '#2a2c2e';
          c.fillRect(x - 11, E.y + 48, 22, 22);
        }
        txt(c, b, x, E.y + 36, 8, legend);
      });
      // Master WARNING (red) and CAUTION (amber) lights, outboard.
      const wx = side < 0 ? E.x + E.w * 0.93 : E.x + E.w * 0.93;
      annunciator(wx - 26, E.y + 18, 52, 30, 'WARNING', undefined, '#ff2020');
      annunciator(wx - 26, E.y + 56, 52, 30, 'CAUTION', undefined, '#ffb000');
    }
  }

  // ── CDUs: screen (lit text) + keypad ──
  for (const key of ['cdu0', 'cdu1', 'cdu2']) {
    const R = ATLAS[key];
    if (!glow) {
      c.fillStyle = '#3f4448';
      c.fillRect(R.x, R.y, R.w, R.h);
    }
    const sx = R.x + 22;
    const sy = R.y + 14;
    const sw = R.w - 44;
    const sh = 150;
    if (!glow) {
      c.fillStyle = '#050706';
      c.fillRect(sx, sy, sw, sh);
    }
    const lines: [string, string, string][] = key === 'cdu2'
      ? [['MENU', '', '#f0f0f0'], ['<FMC', 'SAT>', '#f0f0f0'], ['<ACARS', '', '#f0f0f0'], ['', '', '']]
      : [['TAKEOFF REF', '1/2', '#f0f0f0'], ['FLAPS', 'V1', '#40d8ff'], ['10°', '145KT', '#f0f0f0'], ['THRUST', 'VR', '#40d8ff'], ['TO', '150KT', '#f0f0f0'], ['CG', 'V2', '#40d8ff'], ['21.4%', '162KT', '#f0f0f0'], ['<INDEX', 'POS INIT>', '#f0f0f0']];
    lines.forEach((l, i) => {
      if (!l[2]) return;
      const col = glow ? l[2] : l[2] === '#40d8ff' ? '#2a8aa0' : '#9aa09a';
      txt(c, l[0], sx + 6, sy + 12 + i * 17.5, i === 0 ? 13 : 11, col, 'left', 600);
      txt(c, l[1], sx + sw - 6, sy + 12 + i * 17.5, 11, col, 'right', 600);
    });
    // Line select keys and the keypad.
    if (!glow) {
      c.fillStyle = '#26292b';
      for (let i = 0; i < 6; i++) {
        c.fillRect(R.x + 4, sy + 22 + i * 22, 14, 12);
        c.fillRect(R.x + R.w - 18, sy + 22 + i * 22, 14, 12);
      }
    }
    const keys = ['INIT', 'RTE', 'DEP', 'ATC', 'VNAV', 'FIX', 'LEGS', 'HOLD', 'PROG', 'EXEC'];
    keys.forEach((k, i) => {
      const x = R.x + 20 + (i % 5) * 44;
      const y = R.y + 178 + Math.floor(i / 5) * 26;
      if (!glow) {
        c.fillStyle = '#2b2e30';
        c.fillRect(x, y, 38, 20);
      }
      txt(c, k, x + 19, y + 10, 8, legend);
    });
    const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    for (let i = 0; i < 26; i++) {
      const x = R.x + 92 + (i % 5) * 30;
      const y = R.y + 236 + Math.floor(i / 5) * 26;
      if (!glow) {
        c.fillStyle = '#2b2e30';
        c.fillRect(x, y, 26, 21);
      }
      txt(c, alpha[i], x + 13, y + 11, 11, legend);
    }
    for (let i = 0; i < 12; i++) {
      const x = R.x + 12 + (i % 3) * 26;
      const y = R.y + 236 + Math.floor(i / 3) * 30;
      if (!glow) {
        c.fillStyle = '#2b2e30';
        c.beginPath();
        c.arc(x + 11, y + 11, 11, 0, Math.PI * 2);
        c.fill();
      }
      txt(c, '123456789.0-'[i], x + 11, y + 11, 11, legend);
    }
  }

  // ── Throttle quadrant plate: lever slots, speed brake and flap gate labels, fuel control ──
  {
    const R = ATLAS.quadrant;
    plate(R.x, R.y, R.w, R.h, '#4f5559');
    if (!glow) {
      c.fillStyle = '#101112';
      for (let i = 0; i < 4; i++) c.fillRect(R.x + R.w * (0.36 + i * 0.09) - 5, R.y + 16, 10, R.h * 0.62);
      c.fillRect(R.x + R.w * 0.1 - 5, R.y + 16, 10, R.h * 0.62);
      c.fillRect(R.x + R.w * 0.9 - 5, R.y + 16, 10, R.h * 0.62);
    }
    ['DOWN', 'ARMED', 'UP'].forEach((l, i) => txt(c, l, R.x + R.w * 0.16, R.y + 26 + i * 50, 10, legend, 'left'));
    ['UP', '1', '5', '10', '20', '25', '30'].forEach((l, i) => txt(c, l, R.x + R.w * 0.84, R.y + 20 + i * 24, 11, legend, 'right'));
    txt(c, 'FLAP', R.x + R.w * 0.9, R.y + R.h - 26, 11, legend);
    txt(c, 'SPEED BRAKE', R.x + R.w * 0.1, R.y + R.h - 26, 10, legend, 'left');
    txt(c, 'FUEL CONTROL', R.x + R.w * 0.5, R.y + R.h - 44, 10, legend);
    ['RUN', 'CUTOFF'].forEach((l, i) => txt(c, l, R.x + R.w * 0.5, R.y + R.h - 28 + i * 14, 8, legend));
  }
  // ── Aft pedestal: radio / audio / transponder / weather radar panels ──
  {
    const R = ATLAS.pedestalAft;
    plate(R.x, R.y, R.w, R.h, '#4f5559');
    const panels: [string, number, number, number, number][] = [
      ['VHF L', 0.02, 0.02, 0.47, 0.18],
      ['VHF R', 0.51, 0.02, 0.47, 0.18],
      ['AUDIO', 0.02, 0.22, 0.47, 0.3],
      ['AUDIO', 0.51, 0.22, 0.47, 0.3],
      ['WXR', 0.02, 0.55, 0.47, 0.18],
      ['XPDR', 0.51, 0.55, 0.47, 0.18],
      ['RUDDER TRIM', 0.02, 0.76, 0.96, 0.2],
    ];
    for (const [t, u, v, w, h] of panels) {
      const x = R.x + u * R.w;
      const y = R.y + v * R.h;
      plate(x, y, w * R.w, h * R.h);
      txt(c, t, x + (w * R.w) / 2, y + 12, 10, legend);
      if (t.startsWith('VHF') || t === 'XPDR') {
        c.fillStyle = '#0b0c0c';
        c.fillRect(x + 12, y + 24, w * R.w - 24, 26);
        txt(c, t === 'XPDR' ? '7000' : t === 'VHF L' ? '118.30   121.90' : '121.50   123.45', x + (w * R.w) / 2, y + 37, 14, glow ? '#ffd9a0' : '#c8a870', 'center', 600);
      } else if (t === 'AUDIO') {
        for (let i = 0; i < 8; i++) {
          if (!glow) {
            c.fillStyle = '#2b2e30';
            c.fillRect(x + 12 + i * 21, y + 30, 16, 16);
          }
          txt(c, ['VHF', 'VHF', 'VHF', 'HF', 'HF', 'SAT', 'CAB', 'PA'][i], x + 20 + i * 21, y + 58, 7, legend);
        }
      }
    }
  }
  // ── Side consoles and the circuit-breaker panel ──
  for (const key of ['consoleL', 'consoleR']) {
    const R = ATLAS[key];
    plate(R.x, R.y, R.w, R.h, '#50565a');
    plate(R.x + 8, R.y + 20, R.w - 16, 110);
    txt(c, 'OXYGEN', R.x + R.w / 2, R.y + 34, 6, legend);
    txt(c, 'MIC', R.x + R.w / 2, R.y + 150, 5, legend);
    plate(R.x + 8, R.y + 170, R.w - 16, 90);
    txt(c, 'LIGHTS', R.x + R.w / 2, R.y + 184, 5, legend);
    if (key === 'consoleL') txt(c, 'TILLER', R.x + R.w / 2, R.y + 300, 6, legend);
  }
  {
    const R = ATLAS.cb;
    plate(R.x, R.y, R.w, R.h, '#50565a');
    for (let row = 0; row < 6; row++) {
      for (let i = 0; i < 16; i++) {
        const x = R.x + 16 + i * 22;
        const y = R.y + 18 + row * 26;
        if (!glow) {
          c.fillStyle = '#141516';
          c.beginPath();
          c.arc(x, y + 6, 6, 0, Math.PI * 2);
          c.fill();
        }
        if (i % 3 === 0) txt(c, 'CB', x, y - 6, 6, legend);
      }
    }
  }
  {
    const R = ATLAS.aftWall;
    plate(R.x, R.y, R.w, R.h, '#8f918c');
  }

  // ── Main panel face: labels, clocks, autobrake, heading reference; display cut-outs are dark ──
  {
    const R = ATLAS.main;
    plate(R.x, R.y, R.w, R.h, '#5b6166');
    // Panel coordinate → atlas: px ∈ [−0.86, 0.86] → x; py ∈ [0.14, −0.37] → y.
    const ax = (px: number) => R.x + ((px + 0.86) / 1.72) * R.w;
    const ay = (py: number) => R.y + ((0.14 - py) / 0.51) * R.h;
    // Lower corners outboard of the centre panel are knee space: paint them dark (hidden by geometry anyway).
    if (!glow) {
      c.fillStyle = '#26292b';
      c.fillRect(ax(-0.86), ay(-0.2), ax(-0.3) - ax(-0.86), ay(-0.37) - ay(-0.2));
      c.fillRect(ax(0.3), ay(-0.2), ax(0.86) - ax(0.3), ay(-0.37) - ay(-0.2));
    }
    const labels: [string, number, number][] = [
      ['HDG REF', -0.8, 0.12], ['NORM   TRUE', -0.8, 0.1], ['CLOCK', -0.82, -0.05], ['SOURCE', 0.8, 0.12], ['FMC  L  R', 0.8, 0.1],
      ['AUTOBRAKES', 0.2, -0.2], ['RTO OFF DISARM 1 2 3 4 MAX', 0.2, -0.235], ['GEAR', 0.2, 0.08], ['ALTN FLAPS', -0.2, -0.2], ['BRAKE SOURCE', -0.2, -0.26],
      ['DSPL CTRL', -0.8, -0.14], ['DSPL CTRL', 0.8, -0.14], ['EICAS', -0.15, -0.3], ['ENG  STAT  ELEC  FUEL  ECS  HYD  DRS  GEAR', 0, -0.35],
    ];
    for (const [t, px, py] of labels) txt(c, t, ax(px), ay(py), 11, legend);
    // Gear lever lights: three greens (captain's side of the lever).
    for (let i = 0; i < 3; i++) {
      const x = ax(0.27);
      const y = ay(0.04 - i * 0.035);
      if (!glow) {
        c.fillStyle = '#1b1d1f';
        c.fillRect(x - 16, y - 10, 32, 20);
      }
    }
    // Clock face (captain) and its twin (F/O).
    for (const px of [-0.82, 0.82]) {
      const x = ax(px);
      const y = ay(-0.1);
      if (!glow) {
        c.fillStyle = '#0d0e0f';
        c.beginPath();
        c.arc(x, y, 34, 0, Math.PI * 2);
        c.fill();
      }
      txt(c, '12:34', x, y, 13, glow ? '#ffd9a0' : '#c8a870', 'center', 600);
    }
  }
  c.restore();
}
