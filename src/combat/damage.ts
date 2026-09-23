/**
 * Damage model: how much of a hit's damage gets through a vehicle's armour. The gun's 30 mm
 * armour-piercing rounds are stopped by a tank's frontal armour but go through the thin top and
 * rear plates (why A-10 pilots attack from above and behind); a missile's shaped charge or blast
 * ignores the aspect. Owned by src/combat (the targets owner refines it).
 */
import type { TargetClassConfig } from '../config';
import type { HullFace, WeaponKind } from './types';

export function armorFactor(cls: TargetClassConfig, face: HullFace): number {
  switch (face) {
    case 'front': return cls.armor.front;
    case 'side': return cls.armor.side;
    case 'rear': return cls.armor.rear;
    case 'top': return cls.armor.top;
    case 'bottom': return cls.armor.side;
  }
}

/** Damage that reaches the vehicle, ≥ 0. */
export function effectiveDamage(cls: TargetClassConfig, face: HullFace, weapon: WeaponKind, damage: number): number {
  if (!Number.isFinite(damage) || damage <= 0) return 0;
  return weapon === 'gun' ? damage * armorFactor(cls, face) : damage;
}
