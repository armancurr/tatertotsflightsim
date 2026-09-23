/**
 * Livery painter off the main thread: rasterises the decals with OffscreenCanvas 2D and runs
 * the pure painter (paintLivery), then transfers the pixel buffers back. Replies
 * `{ ok: false }` when OffscreenCanvas 2D is unavailable, so the page paints synchronously.
 */
import { rasterizeLiveryDecals } from './decals';
import { paintLivery } from './livery';

interface Request {
  id: number;
  quality: 'high' | 'low';
  registration: string;
}

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, quality, registration } = e.data;
  try {
    if (typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1, 1).getContext('2d')) {
      self.postMessage({ id, ok: false });
      return;
    }
    const decals = rasterizeLiveryDecals((w, h) => {
      const c = new OffscreenCanvas(w, h);
      return { getContext: (type: '2d') => c.getContext(type, { willReadFrequently: true }) };
    }, registration);
    const px = paintLivery(quality, decals);
    (self as unknown as Worker).postMessage({ id, ok: true, px }, [px.map.buffer, px.orm.buffer, px.normal.buffer, px.cabin.buffer, px.fin.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err) });
  }
};
