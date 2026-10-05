/**
 * engineMath.js
 * -------------
 * Small numerical helpers the dispersion engine needs and JavaScript does not
 * provide. Kept separate so they can be unit-tested in isolation and audited
 * without wading through dispersion physics.
 */

/**
 * Gauss error function, erf(x).
 *
 * JavaScript has no built-in erf, and the Gaussian dispersion model needs it
 * for the finite-duration release term (Palazzi et al. 1982, see
 * engineGaussian.js).
 *
 * Implementation: Abramowitz & Stegun, Handbook of Mathematical Functions,
 * formula 7.1.26. Maximum absolute error 1.5e-7, which is several orders of
 * magnitude below the uncertainty of the dispersion model itself, so it is
 * not a meaningful source of error here.
 *
 * @param {number} x
 * @returns {number} erf(x), in the range (-1, 1)
 */
export function erf(x) {
  // erf is odd: erf(-x) = -erf(x). Work with |x| and restore the sign later.
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * absX);
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return sign * y;
}

/**
 * Clamps a value to a range. Used to keep physically meaningless inputs
 * (negative distances, zero wind) from propagating silently through the model.
 */
export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Finds the largest x in [lowerBound, upperBound] for which
 * predicate(x) is true, assuming predicate is monotonically decreasing
 * (true near lowerBound, false near upperBound).
 *
 * Used to locate the edge of a threat zone: the furthest downwind distance at
 * which concentration still exceeds the Level of Concern. A bisection is used
 * rather than a fine linear scan because concentration falls off over several
 * orders of magnitude and a fixed step would be either too slow or too coarse.
 *
 * @param {(x: number) => boolean} predicate
 * @param {number} lowerBound - a value where predicate is known to be true
 * @param {number} upperBound - a value where predicate is known to be false
 * @param {number} tolerance - stop when the bracket is narrower than this (m)
 * @returns {number}
 */
export function bisectBoundary(predicate, lowerBound, upperBound, tolerance = 0.5) {
  let low = lowerBound;
  let high = upperBound;

  // A hard iteration cap guarantees termination even if the predicate is not
  // perfectly monotonic due to floating-point noise near the boundary.
  for (let i = 0; i < 100 && high - low > tolerance; i++) {
    const mid = (low + high) / 2;
    if (predicate(mid)) {
      low = mid;
    } else {
      high = mid;
    }
  }

  return low;
}
