/**
 * Generates the terrain's noise texture and detail textures off the main thread
 * (≈1–2 s of work at 512²) and transfers them back: first the small noise texture
 * (the terrain waits for it), then the detail set (faded in when it arrives).
 */
import { generateDetailSet, generateNoiseTexture } from './detailTextures';

interface Req {
  size: number;
  noiseSize: number;
  seed: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const { size, noiseSize, seed } = e.data;
  const noise = generateNoiseTexture(noiseSize, seed);
  ctx.postMessage({ type: 'noise', size: noiseSize, data: noise }, [noise.buffer]);
  const set = generateDetailSet(size, seed);
  ctx.postMessage({ type: 'detail', size: set.size, layers: set.layers, albedo: set.albedo, normal: set.normal }, [set.albedo.buffer, set.normal.buffer]);
};
