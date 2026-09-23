/**
 * Placard speeds the instruments and the physics share, as tiny pure functions with no dependency but
 * the config (the HUD imports this without pulling in the flight model).
 */
import { CONFIG, type Config } from '../config';

/**
 * Flap placard speed (kt) for a flap angle: Infinity with the flaps up; with flaps.placardKt the
 * placard of the lowest notch at or beyond the angle (a flap in transit counts as the next notch
 * down), otherwise flaps.vfeKt.
 */
export function flapPlacardKt(flapsDeg: number, cfg: Config = CONFIG): number {
  const fl = cfg.aircraft.flaps;
  if (!(flapsDeg > 0.5)) return Infinity;
  const table = fl.placardKt;
  if (!table || table.length !== fl.notchesDeg.length) return fl.vfeKt;
  for (let i = 1; i < fl.notchesDeg.length; i++) {
    if (fl.notchesDeg[i] >= flapsDeg - 0.5) return table[i];
  }
  return table[table.length - 1];
}
