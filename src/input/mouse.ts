/**
 * Mouse / pointer DOM adapter for the canvas.
 *
 * - Drag (any button, primary pointer) with pointer capture → dx/dy in CSS pixels, accumulated
 *   between frames and consumed by frame().
 * - Wheel → notches (+ = scroll down), preventDefault (non-passive) so the page never scrolls.
 * - Pointer position normalised to -1..1 from the canvas centre (+x right, +y down) for the mouse yoke.
 * - Context menu suppressed on the canvas; touch-action none so touch drags don't scroll/zoom.
 */
import type { MouseFrame } from './controlSystem';

export interface MouseTracker {
  /** Current pointer state + deltas since the last call (deltas are reset). */
  frame(): MouseFrame;
  dispose(): void;
}

/** Wheel delta → notches, for each WheelEvent.deltaMode (pixel, line, page). */
function wheelNotches(e: WheelEvent): number {
  const d = Number.isFinite(e.deltaY) ? e.deltaY : 0;
  switch (e.deltaMode) {
    case 1: return d / 3; // lines (Firefox: 3 lines per notch)
    case 2: return d; // pages
    default: return d / 100; // pixels (Chrome/Safari: ~100 px per notch)
  }
}

export function createMouse(canvas: HTMLElement): MouseTracker {
  let dx = 0;
  let dy = 0;
  let wheel = 0;
  let dragging = false;
  let dragPointer: number | null = null;
  let lastX = 0;
  let lastY = 0;
  let x = 0;
  let y = 0;
  let inside = false;

  const updatePosition = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      x = ((clientX - r.left) / r.width) * 2 - 1;
      y = ((clientY - r.top) / r.height) * 2 - 1;
      inside = x >= -1 && x <= 1 && y >= -1 && y <= 1;
    }
  };

  const onDown = (e: PointerEvent) => {
    updatePosition(e.clientX, e.clientY);
    if (dragPointer !== null) return; // ignore a second finger
    dragPointer = e.pointerId;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    try { canvas.setPointerCapture?.(e.pointerId); } catch { /* not supported (tests, old browsers) */ }
  };

  const onMove = (e: PointerEvent) => {
    updatePosition(e.clientX, e.clientY);
    if (dragging && e.pointerId === dragPointer) {
      dx += e.clientX - lastX;
      dy += e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
    }
  };

  const endDrag = (e: PointerEvent) => {
    if (e.pointerId !== dragPointer) return;
    dragging = false;
    dragPointer = null;
    try { canvas.releasePointerCapture?.(e.pointerId); } catch { /* already released */ }
  };

  const onLeave = () => {
    if (!dragging) inside = false;
  };
  const onEnter = (e: PointerEvent) => updatePosition(e.clientX, e.clientY);

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    wheel += wheelNotches(e);
  };
  const onContextMenu = (e: Event) => e.preventDefault();

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('lostpointercapture', endDrag);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('pointerenter', onEnter);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  const prevTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  return {
    frame(): MouseFrame {
      const f: MouseFrame = { dx, dy, wheel, dragging, x, y, inside };
      dx = 0;
      dy = 0;
      wheel = 0;
      return f;
    },
    dispose() {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', endDrag);
      canvas.removeEventListener('pointercancel', endDrag);
      canvas.removeEventListener('lostpointercapture', endDrag);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('pointerenter', onEnter);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.style.touchAction = prevTouchAction;
      dragging = false;
      dragPointer = null;
    },
  };
}
