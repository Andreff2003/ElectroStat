/**
 * Centralised physical / numerical constants used across the CV pipeline.
 * Importing from this single module keeps the simulator, metrics,
 * calibration and CSV export honest about which numbers are shared.
 *
 * NOTE: production CV code should NEVER hardcode these values. Tests may
 * use literals when the literal itself is what is being tested.
 */
export const CV_F = 96485.33212;          // C/mol
export const CV_R = 8.314462618;          // J/(mol·K)
export const CV_T_DEFAULT_K = 298.15;     // K (25 °C)
export const CV_DEFAULT_D_CM2_S = 7.26e-6; // cm²/s — Fe(CN)6³⁻/⁴⁻ in aqueous KCl
export const CV_E0_PRIME_DEFAULT_V = 0.22; // V — Fe(CN)6³⁻/⁴⁻ formal potential

/**
 * Peak-to-peak separation ΔEp of a reversible, diffusion-controlled
 * one-electron couple at 25 °C: 2.218·RT/F ≈ 57 mV, and 57/n mV for n
 * electrons (Nicholson & Shain 1964; Elgrishi et al., J. Chem. Educ. 2018,
 * 95, 197–206).
 *
 * This is NOT the Nernst slope. 2.303·RT/F = 59.16 mV is the potential change
 * per decade of concentration ratio, a different quantity that must not be
 * used as the expected ΔEp.
 */
export const CV_DELTA_EP_REVERSIBLE_MV = (2.218 * 1000 * CV_R * CV_T_DEFAULT_K) / CV_F; // ≈ 56.99 mV

/** Randles–Ševčík prefactor at 25 °C (0.4463 · F · sqrt(F/RT)) ≈ 268648.45 */
export const CV_RS_PREFACTOR =
  0.4463 * CV_F * Math.sqrt(CV_F / (CV_R * CV_T_DEFAULT_K));

/**
 * Default numerical parameters for `simulateReversibleDiffusionCV`.
 * Exported so CSV export, UI and tests reference the same numbers as the
 * solver. Tuned to balance accuracy vs solve time:
 *  - 2 mV per potential step gives ~400 points/cycle at standard windows
 *  - 2500 spatial nodes on the 1-D semi-infinite mesh L ≈ 6·√(D·tMax) put the
 *    reversible peak current within 0.4 % of Randles–Ševčík and ΔEp at 58 mV
 *    (57 mV theory); 180 nodes under-resolved the diffusion layer (−5 % Ip,
 *    ΔEp 64 mV). Solve time stays around 65 ms.
 */
export const CV_SOLVER_DEFAULT_STEP_V = 0.002;       // V per ramp step
export const CV_SOLVER_DEFAULT_SPATIAL_NODES = 2500; // mesh nodes
export const CV_SOLVER_DOMAIN_RULE = "L = 6*sqrt(D*tMax)";

/**
 * Butler–Volmer kinetic constants — shared by the quasi-reversible CV and
 * SWV solvers so both modes agree on the same numerical regime.
 */
export const CV_BV_K0 = 0.01;    // cm/s — heterogeneous rate constant
export const CV_BV_ALPHA = 0.5;  // charge-transfer coefficient
// The semi-implicit Butler–Volmer update stays finite for any k, so this only
// guards overflow. A low ceiling (it was 10 cm/s) breaks Nernst equilibrium away
// from E0' and made k0 = 10 look irreversible (ΔEp 112 mV instead of ~58).
export const CV_BV_K_MAX = 1e6;  // cm/s

