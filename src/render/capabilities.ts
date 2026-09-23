/**
 * Can this browser run the simulator? Probed once at boot (main.ts), before the 2 MB of game code is
 * loaded, so a browser without WebGL 2 gets a friendly explanation instead of a blank page.
 *
 * Pure apart from the canvas factory it is given (tests pass fakes).
 */

export type WebGLProblem = 'no-webgl2' | 'webgl1-only' | 'context-failed';

export interface WebGLCapabilities {
  ok: boolean;
  problem: WebGLProblem | null;
  /** UNMASKED_RENDERER_WEBGL where available, else RENDERER ('' when there is no context). */
  renderer: string;
  /** Linear-HDR rendering needs float colour buffers (else the renderer falls back to LDR). */
  floatColorBuffer: boolean;
  /** Reversed-Z depth (else a logarithmic depth buffer is used). */
  clipControl: boolean;
  /** Worker + module worker + OffscreenCanvas 2D, used by the streaming workers (all have main-thread fallbacks). */
  workers: boolean;
  offscreenCanvas: boolean;
}

interface CanvasLike {
  getContext(kind: string, attrs?: unknown): unknown;
}

export interface ProbeEnv {
  createCanvas(): CanvasLike | null;
  /** typeof WebGL2RenderingContext !== 'undefined' */
  hasWebGL2Api: boolean;
  hasWorker: boolean;
  hasOffscreenCanvas: boolean;
}

type GL = {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
  RENDERER: number;
};

/** The real browser environment. */
export function browserProbeEnv(doc: Document = document): ProbeEnv {
  const g = globalThis as unknown as Record<string, unknown>;
  return {
    createCanvas: () => {
      try {
        return doc.createElement('canvas');
      } catch {
        return null;
      }
    },
    hasWebGL2Api: typeof g.WebGL2RenderingContext !== 'undefined',
    hasWorker: typeof g.Worker !== 'undefined',
    hasOffscreenCanvas: typeof g.OffscreenCanvas !== 'undefined',
  };
}

export function probeWebGL(env: ProbeEnv): WebGLCapabilities {
  const base: WebGLCapabilities = {
    ok: false, problem: null, renderer: '', floatColorBuffer: false, clipControl: false,
    workers: env.hasWorker, offscreenCanvas: env.hasOffscreenCanvas,
  };
  const canvas = env.createCanvas();
  let gl: GL | null = null;
  try {
    gl = (canvas?.getContext('webgl2', { powerPreference: 'high-performance' }) as GL | null) ?? null;
  } catch {
    gl = null;
  }
  if (!gl) {
    let webgl1 = false;
    try {
      const c1 = env.createCanvas();
      webgl1 = !!(c1?.getContext('webgl') ?? c1?.getContext('experimental-webgl'));
    } catch {
      webgl1 = false;
    }
    return { ...base, problem: env.hasWebGL2Api ? 'context-failed' : webgl1 ? 'webgl1-only' : 'no-webgl2' };
  }
  let renderer = '';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
    renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch {
    renderer = '';
  }
  const has = (name: string) => {
    try {
      return !!gl!.getExtension(name);
    } catch {
      return false;
    }
  };
  const caps: WebGLCapabilities = { ...base, ok: true, renderer, floatColorBuffer: has('EXT_color_buffer_float'), clipControl: has('EXT_clip_control') };
  try {
    (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
  } catch {
    /* the probe context is garbage anyway */
  }
  return caps;
}
