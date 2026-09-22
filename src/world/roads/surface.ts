/**
 * The road surface as rendered, for things that drive on it (PURE): per piece,
 * the kept ribbon sections of every built near chunk (builder.ts RunProfile).
 * Height at (piece, s, across) interpolates exactly like the GPU does between
 * sections (linear along; linear from the centre to the paved edge across).
 */
import type { RunProfile } from './builder';

interface Entry {
  key: string;
  s0: number;
  s1: number;
  p: RunProfile;
}

export class RoadSurface {
  private byPiece = new Map<number, Entry[]>();
  private byKey = new Map<string, Entry[]>();

  add(key: string, profiles: readonly RunProfile[]): void {
    this.remove(key);
    const mine: Entry[] = [];
    for (const p of profiles) {
      if (p.s.length < 2) continue;
      const e: Entry = { key, s0: p.s[0], s1: p.s[p.s.length - 1], p };
      mine.push(e);
      let l = this.byPiece.get(p.piece);
      if (!l) this.byPiece.set(p.piece, (l = []));
      l.push(e);
      l.sort((a, b) => a.s0 - b.s0);
    }
    this.byKey.set(key, mine);
  }

  remove(key: string): void {
    const mine = this.byKey.get(key);
    if (!mine) return;
    for (const e of mine) {
      const l = this.byPiece.get(e.p.piece);
      if (!l) continue;
      const i = l.indexOf(e);
      if (i >= 0) l.splice(i, 1);
      if (l.length === 0) this.byPiece.delete(e.p.piece);
    }
    this.byKey.delete(key);
  }

  /** True if the whole range [s0, s1] of the piece has surface data. */
  covers(piece: number, s0: number, s1: number): boolean {
    const l = this.byPiece.get(piece);
    if (!l) return false;
    let at = s0;
    for (const e of l) {
      if (e.s0 > at + 0.01) return false;
      if (e.s1 >= at) at = e.s1;
      if (at >= s1 - 0.01) return true;
    }
    return at >= s1 - 0.01;
  }

  /**
   * Surface height at arc length s, `across` metres right of the centreline
   * (clamped to the paved half width hw); NaN where no chunk is built.
   */
  height(piece: number, s: number, across: number, hw: number): number {
    const l = this.byPiece.get(piece);
    if (!l) return NaN;
    for (let i = 0; i < l.length; i++) {
      const e = l[i];
      if (s < e.s0 - 1e-3 || s > e.s1 + 1e-3) continue;
      const S = e.p.s;
      // binary search the section
      let lo = 0;
      let hi = S.length - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (S[m] <= s) lo = m;
        else hi = m;
      }
      const t = S[hi] > S[lo] ? Math.max(0, Math.min(1, (s - S[lo]) / (S[hi] - S[lo]))) : 0;
      const c = e.p.yC[lo] + (e.p.yC[hi] - e.p.yC[lo]) * t;
      const a = Math.max(-1, Math.min(1, across / hw));
      const edge = a >= 0 ? e.p.yR[lo] + (e.p.yR[hi] - e.p.yR[lo]) * t : e.p.yL[lo] + (e.p.yL[hi] - e.p.yL[lo]) * t;
      return c + (edge - c) * Math.abs(a);
    }
    return NaN;
  }

  get pieceCount(): number {
    return this.byPiece.size;
  }
}
