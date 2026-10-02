// Numeric building blocks (spec §6, §8.5, Appendix A).

/** Appendix A: Numerical Recipes erfcc (normative). */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))))
    );
  return x >= 0 ? r : 2 - r;
}

/** Standard normal CDF. */
export function phi(x: number): number {
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Inverse standard normal (Acklam's algorithm + one Halley refinement), accurate well beyond 1e-9. */
export function phiInv(p: number): number {
  if (p === 0.2) return -0.8416212335729143;
  if (p === 0.8) return 0.8416212335729143;
  if (p <= 0 || p >= 1) throw new RangeError("phiInv domain");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let x: number;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pl) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = phi(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

export function grid(min: number, max: number, step: number): number[] {
  const n = Math.round((max - min) / step) + 1;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = min + i * step;
  return out;
}

export function normalize(w: number[]): number[] {
  let s = 0;
  for (const x of w) s += x;
  if (!(s > 0)) return w.map(() => 1 / w.length);
  return w.map((x) => x / s);
}

export function gaussianPrior(g: number[], mu: number, sigma: number): number[] {
  return normalize(g.map((c) => Math.exp(-0.5 * ((c - mu) / sigma) ** 2)));
}

export function quantile(g: number[], w: number[], q: number): number {
  let cum = 0;
  for (let i = 0; i < w.length; i++) {
    cum += w[i];
    if (cum >= q - 1e-12) return g[i];
  }
  return g[g.length - 1];
}

export function meanSigma(g: number[], w: number[]): { mean: number; sigma: number } {
  let m = 0;
  for (let i = 0; i < w.length; i++) m += w[i] * g[i];
  let v = 0;
  for (let i = 0; i < w.length; i++) v += w[i] * (g[i] - m) ** 2;
  return { mean: m, sigma: Math.sqrt(v) };
}

/** w_i <- w_i * max(L_i, 1e-9), normalised. */
export function update(w: number[], L: (i: number) => number): number[] {
  return normalize(w.map((x, i) => x * Math.max(L(i), 1e-9)));
}

export function forget(w: number[], prior: number[], f: number): number[] {
  return w.map((x, i) => (1 - f) * x + f * prior[i]);
}

/** Caution: w_i <- w_i^(1/lambda^2), normalised (§7.5). */
export function temper(w: number[], lambda: number): number[] {
  const e = 1 / (lambda * lambda);
  return normalize(w.map((x) => Math.pow(x, e)));
}

export function product(a: number[], b: number[]): number[] {
  return normalize(a.map((x, i) => x * b[i]));
}

/** §8.5 mulberry32. Returns [value in [0,1), next state]. */
export function mulberry32(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/** Round half up to a step, with the step's decimal precision (exact output). */
export function roundStep(x: number, step: number): number {
  const decimals = Math.max(0, (String(step).split(".")[1] || "").length);
  const v = Math.floor(x / step + 0.5 + 1e-9) * step;
  return Number(v.toFixed(decimals));
}
