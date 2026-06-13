// graph-preview.ts — constant-folding preview swatch for a material graph.
//
// Pure + node-free (imported by BOTH the server file scan and the web UI, same
// approach as crawl-types.ts/db-types.ts). Evaluates the chain feeding the
// MaterialOutput's BaseColor (falling back to EmissiveColor) across the
// constant/parameter/math node subset below and returns an sRGB-ish [r,g,b]
// in 0–1, or null when the chain hits anything it cannot fold (textures,
// world-position, MF calls, …). Honesty over coverage: no value is invented —
// an unfoldable chain simply shows no swatch.

export interface PreviewNode { id: string; type: string; params?: Record<string, unknown> }
export interface PreviewConnection { from: string; to: string }
export interface PreviewGraph {
  type?: string;
  nodes: PreviewNode[];
  connections: PreviewConnection[];
}

export type RGB = [number, number, number];

type Vec = number[]; // 1–4 components

const MAX_DEPTH = 64;

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function vecFrom(v: unknown): Vec | null {
  if (typeof v === 'number') return Number.isFinite(v) ? [v] : null;
  if (Array.isArray(v) && v.length >= 1 && v.length <= 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return v as number[];
  }
  return null;
}

/** Component-wise broadcast: scalar stretches to the other side's length. */
function zip(a: Vec, b: Vec, f: (x: number, y: number) => number): Vec | null {
  if (a.length === b.length) return a.map((x, i) => f(x, b[i]));
  if (a.length === 1) return b.map((y) => f(a[0], y));
  if (b.length === 1) return a.map((x) => f(x, b[0]));
  return null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Pick a named component (R/G/B/A) off a vec; full-vec pins pass through. */
function selectOutput(value: Vec, pin: string): Vec | null {
  const comp: Record<string, number> = { R: 0, G: 1, B: 2, A: 3 };
  if (pin in comp) {
    const i = comp[pin];
    return i < value.length ? [value[i]] : null;
  }
  return value; // RGB / RGBA / Result / unnamed → the whole value
}

export function evaluateGraphPreview(graph: PreviewGraph): RGB | null {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.connections)) return null;
  const out = graph.nodes.find((n) => n.type === 'MaterialOutput');
  if (!out) return null;

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // input ref "node:Pin" → source ref "node:Pin"
  const intoPin = new Map<string, string>();
  for (const c of graph.connections) {
    if (typeof c.from === 'string' && typeof c.to === 'string') intoPin.set(c.to, c.from);
  }

  function inputVec(nodeId: string, pin: string, depth: number, seen: Set<string>): Vec | null {
    const src = intoPin.get(`${nodeId}:${pin}`);
    if (!src) return null;
    const i = src.lastIndexOf(':');
    if (i <= 0) return null;
    const srcId = src.slice(0, i);
    const srcPin = src.slice(i + 1);
    const value = evalNode(srcId, depth + 1, seen);
    return value ? selectOutput(value, srcPin) : null;
  }

  /** Input pin if wired, else a constant fallback param. */
  function inputOr(nodeId: string, pin: string, fallback: number | null, p: Record<string, unknown>, fallbackKey: string, depth: number, seen: Set<string>): Vec | null {
    const wired = intoPin.has(`${nodeId}:${pin}`);
    if (wired) return inputVec(nodeId, pin, depth, seen);
    if (fallbackKey in p) {
      const v = vecFrom(p[fallbackKey]);
      if (v) return v;
    }
    return fallback === null ? null : [fallback];
  }

  function evalNode(id: string, depth: number, seen: Set<string>): Vec | null {
    if (depth > MAX_DEPTH || seen.has(id)) return null;
    const n = byId.get(id);
    if (!n) return null;
    seen.add(id);
    try {
      const p = n.params ?? {};
      switch (n.type) {
        case 'Constant':
          return [num(p.R, 0)];
        case 'Constant2Vector':
          return vecFrom(p.Constant) ?? [num(p.R, 0), num(p.G, 0)];
        case 'Constant3Vector':
          return vecFrom(p.Constant) ?? [num(p.R, 0), num(p.G, 0), num(p.B, 0)];
        case 'Constant4Vector':
          return vecFrom(p.Constant) ?? [num(p.R, 0), num(p.G, 0), num(p.B, 0), num(p.A, 0)];
        case 'ScalarParameter':
          return [num(p.DefaultValue, 0)];
        case 'VectorParameter':
          return vecFrom(p.DefaultValue);
        case 'StaticSwitchParameter': {
          const branch = p.DefaultValue === true ? 'True' : 'False';
          return inputVec(id, branch, depth, seen);
        }
        case 'Add': {
          const a = inputOr(id, 'A', null, p, 'ConstA', depth, seen);
          const b = inputOr(id, 'B', null, p, 'ConstB', depth, seen);
          return a && b ? zip(a, b, (x, y) => x + y) : null;
        }
        case 'Subtract': {
          const a = inputOr(id, 'A', null, p, 'ConstA', depth, seen);
          const b = inputOr(id, 'B', null, p, 'ConstB', depth, seen);
          return a && b ? zip(a, b, (x, y) => x - y) : null;
        }
        case 'Multiply': {
          const a = inputOr(id, 'A', null, p, 'ConstA', depth, seen);
          const b = inputOr(id, 'B', null, p, 'ConstB', depth, seen);
          return a && b ? zip(a, b, (x, y) => x * y) : null;
        }
        case 'Divide': {
          const a = inputOr(id, 'A', null, p, 'ConstA', depth, seen);
          const b = inputOr(id, 'B', null, p, 'ConstB', depth, seen);
          return a && b ? zip(a, b, (x, y) => (y === 0 ? 0 : x / y)) : null;
        }
        case 'Lerp':
        case 'LinearInterpolate': {
          const a = inputOr(id, 'A', null, p, 'ConstA', depth, seen);
          const b = inputOr(id, 'B', null, p, 'ConstB', depth, seen);
          const t = inputOr(id, 'Alpha', 0.5, p, 'ConstAlpha', depth, seen);
          if (!a || !b || !t) return null;
          const mixed = zip(a, b, (x, y) => x + (y - x) * t[0]);
          return mixed;
        }
        case 'Power': {
          const base = inputVec(id, 'Base', depth, seen);
          const exp = inputOr(id, 'Exp', num(p.ConstExponent, 2), p, 'ConstExponent', depth, seen);
          return base && exp ? base.map((x) => Math.pow(Math.max(0, x), exp[0])) : null;
        }
        case 'OneMinus':
          return inputVec(id, 'Input', depth, seen)?.map((x) => 1 - x) ?? null;
        case 'Saturate':
          return inputVec(id, 'Input', depth, seen)?.map(clamp01) ?? null;
        case 'Clamp': {
          const v = inputVec(id, 'Input', depth, seen);
          if (!v) return null;
          const lo = inputOr(id, 'Min', num(p.MinDefault, 0), p, 'MinDefault', depth, seen);
          const hi = inputOr(id, 'Max', num(p.MaxDefault, 1), p, 'MaxDefault', depth, seen);
          if (!lo || !hi) return null;
          return v.map((x) => Math.min(hi[0], Math.max(lo[0], x)));
        }
        case 'AppendVector': {
          const a = inputVec(id, 'A', depth, seen);
          const b = inputVec(id, 'B', depth, seen);
          if (!a || !b || a.length + b.length > 4) return null;
          return [...a, ...b];
        }
        case 'ComponentMask': {
          const v = inputVec(id, 'Input', depth, seen);
          if (!v) return null;
          const picked: number[] = [];
          const flags: Array<[string, number]> = [['R', 0], ['G', 1], ['B', 2], ['A', 3]];
          for (const [key, idx] of flags) {
            if (p[key] === true) {
              if (idx >= v.length) return null;
              picked.push(v[idx]);
            }
          }
          return picked.length > 0 ? picked : null;
        }
        case 'Desaturation': {
          const v = inputVec(id, 'Input', depth, seen);
          if (!v || v.length < 3) return null;
          const frac = inputOr(id, 'Fraction', 1, p, 'Fraction', depth, seen);
          if (!frac) return null;
          const lum = v[0] * 0.3 + v[1] * 0.59 + v[2] * 0.11;
          return v.slice(0, 3).map((x) => x + (lum - x) * frac[0]);
        }
        default:
          return null; // anything else (textures, coords, MFs, …) is unfoldable
      }
    } finally {
      seen.delete(id);
    }
  }

  for (const pin of ['BaseColor', 'EmissiveColor']) {
    const v = inputVec(out.id, pin, 0, new Set());
    if (v) {
      // Scalars replicate to grey (UE float→float3 cast); float2 pads blue with 0.
      const r = v[0];
      const g = v.length >= 2 ? v[1] : v[0];
      const b = v.length >= 3 ? v[2] : v.length === 1 ? v[0] : 0;
      return [clamp01(r), clamp01(g), clamp01(b)];
    }
  }
  return null;
}
