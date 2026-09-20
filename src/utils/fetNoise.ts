/**
 * Relative read-out noise of a BioFET transfer curve.
 *
 * In strong inversion the drain current is quadratic in the gate voltage,
 * Id ≈ K·(Vg − Vt)², so a quadratic fit through the on-state removes the
 * deterministic curve and what remains is measurement scatter. The result is
 * the RMS of the residuals as a percentage of the mean current in that region.
 *
 * The deep-off region cannot be used for this: there Id is ~1e-7 µA and rises
 * exponentially with Vg, so its spread reflects the slope (or the instrument's
 * absolute noise floor), not the repeatability of the reading.
 */
export interface FETCurvePoint {
  vg: number;
  id: number;
}

/** Points above this fraction of Ion count as on-state. */
export const FET_NOISE_ON_FRACTION = 0.3;
const MIN_POINTS = 8;

export function fetOnStateNoisePct(curve: FETCurvePoint[]): number | null {
  const pts = curve
    .filter((p) => Number.isFinite(p.vg) && Number.isFinite(p.id))
    .sort((a, b) => a.vg - b.vg);
  if (pts.length < MIN_POINTS) return null;

  const winSize = Math.max(3, Math.floor(pts.length * 0.1));
  const top = pts.slice(-winSize).map((p) => Math.abs(p.id)).sort((a, b) => a - b);
  const ion = top[Math.floor(top.length / 2)];
  if (!(ion > 0)) return null;

  const region = pts.filter((p) => Math.abs(p.id) >= FET_NOISE_ON_FRACTION * ion);
  if (region.length < MIN_POINTS) return null;

  // Least-squares quadratic in the centred/scaled gate voltage (well conditioned).
  const v0 = (region[0].vg + region[region.length - 1].vg) / 2;
  const vs = (region[region.length - 1].vg - region[0].vg) / 2 || 1;
  const xs = region.map((p) => (p.vg - v0) / vs);
  const ys = region.map((p) => p.id);
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const r = [0, 0, 0];
  xs.forEach((x, i) => {
    const b = [1, x, x * x];
    for (let a = 0; a < 3; a++) {
      r[a] += b[a] * ys[i];
      for (let c = 0; c < 3; c++) m[a][c] += b[a] * b[c];
    }
  });
  // Solve the 3x3 normal equations by Gaussian elimination with pivoting.
  const A = m.map((row, i) => [...row, r[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let k = col + 1; k < 3; k++) if (Math.abs(A[k][col]) > Math.abs(A[piv][col])) piv = k;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let k = col + 1; k < 3; k++) {
      const f = A[k][col] / A[col][col];
      for (let c = col; c < 4; c++) A[k][c] -= f * A[col][c];
    }
  }
  const coef = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = A[i][3];
    for (let c = i + 1; c < 3; c++) s -= A[i][c] * coef[c];
    coef[i] = s / A[i][i];
  }

  let ss = 0;
  xs.forEach((x, i) => {
    const fit = coef[0] + coef[1] * x + coef[2] * x * x;
    ss += (ys[i] - fit) ** 2;
  });
  const rms = Math.sqrt(ss / Math.max(1, region.length - 3));
  const meanAbs = ys.reduce((a, y) => a + Math.abs(y), 0) / ys.length;
  return meanAbs > 0 ? (100 * rms) / meanAbs : null;
}
