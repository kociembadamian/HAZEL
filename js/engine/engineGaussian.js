/**
 * engineGaussian.js
 * -----------------
 * The Gaussian dispersion model for neutrally buoyant gases.
 *
 * Scope: this model applies to vapour clouds that do not significantly affect
 * the ambient air flow and are not driven by gravity — "passive pollutants"
 * in the language of the Tech Doc (section 4.3). Clouds that are appreciably
 * denser than air require the heavy gas model instead; that is a separate
 * module and is NOT implemented here. engineLimitations.js states where the
 * boundary lies.
 *
 * Structure of the calculation, in the order the functions appear below:
 *   1. sigmaY / sigmaZ / sigmaX  - how wide the plume has spread at distance x
 *   2. windSpeedAtHeight          - shift the measured wind to the height needed
 *   3. verticalTerm / crosswindTerm - the Gaussian profile in each direction
 *   4. steadyStateConcentration   - concentration for an infinite-duration release
 *   5. peakConcentration          - correction for a release of finite duration
 *   6. findThreatZone             - the distance at which concentration = LOC
 *
 * References:
 *   Tech Doc = ALOHA 5.4.4 Technical Documentation, NOAA TM NOS OR&R 43 (2013)
 *   Briggs (1973), Beals (1971), Palazzi et al. (1982), Hanna et al. (1982)
 */

import {
  BRIGGS_COEFFICIENTS,
  WIND_PROFILE_EXPONENTS,
  ROUGHNESS_URBAN_THRESHOLD,
  UNIVERSAL_GAS_CONSTANT,
  STANDARD_PRESSURE,
  MIN_WIND_SPEED,
  MAX_RELEASE_DURATION,
} from "./engineConstants.js";
import { erf, bisectBoundary } from "./engineMath.js";

/** Number of image reflections used when an inversion lid is present (Tech Doc 4.3). */
const INVERSION_REFLECTIONS = 5;

/* ========================================================================
   1. DISPERSION PARAMETERS (plume spread)
   ======================================================================== */

/**
 * Crosswind (lateral) dispersion parameter.
 *   sigmaY = sy1 * x * (1 + sy2 * x)^(-1/2)
 *
 * Note this uses the rural coefficient set for every roughness, following the
 * Tech Doc — see the explanation in engineConstants.js.
 *
 * @param {number} x - downwind distance in metres
 * @param {string} stabilityClass - "A".."F"
 * @returns {number} standard deviation of the crosswind concentration profile (m)
 */
export function sigmaY(x, stabilityClass) {
  if (x <= 0) return 0;
  const { sy1, sy2 } = BRIGGS_COEFFICIENTS.crosswind[stabilityClass];
  return (sy1 * x) / Math.sqrt(1 + sy2 * x);
}

/**
 * Vertical dispersion parameter.
 *   sigmaZ = sz1 * x * (1 + sz2 * x)^sz3
 *
 * Unlike sigmaY, this one does depend on surface roughness: the Gaussian model
 * distinguishes "large" from "small" roughness at a 20 cm threshold.
 *
 * @param {number} x - downwind distance in metres
 * @param {string} stabilityClass - "A".."F"
 * @param {number} roughnessLength - surface roughness z0 in metres
 * @returns {number} standard deviation of the vertical concentration profile (m)
 */
export function sigmaZ(x, stabilityClass, roughnessLength) {
  if (x <= 0) return 0;
  const isUrban = roughnessLength >= ROUGHNESS_URBAN_THRESHOLD;
  const table = isUrban
    ? BRIGGS_COEFFICIENTS.verticalUrban
    : BRIGGS_COEFFICIENTS.verticalRural;
  const { sz1, sz2, sz3 } = table[stabilityClass];
  return sz1 * x * Math.pow(1 + sz2 * x, sz3);
}

/**
 * Alongwind dispersion parameter (Beals 1971).
 *   sigmaX = sx1 * x^sx2
 *
 * This one only matters for releases of finite duration — it governs how much
 * the leading and trailing edges of the cloud smear out along the wind. For a
 * steady continuous release it drops out of the calculation entirely.
 *
 * @param {number} x - downwind distance in metres
 * @param {string} stabilityClass - "A".."F"
 * @returns {number} standard deviation of the alongwind concentration profile (m)
 */
export function sigmaX(x, stabilityClass) {
  if (x <= 0) return 0;
  const { sx1, sx2 } = BRIGGS_COEFFICIENTS.alongwind[stabilityClass];
  return sx1 * Math.pow(x, sx2);
}

/* ========================================================================
   2. WIND PROFILE
   ======================================================================== */

/**
 * Shifts a wind speed from the height at which it was measured to the height
 * the model needs, using the power-law profile
 *   U2 = U1 * (z2 / z1)^n
 * with n taken from the stability class (Tech Doc Table 7).
 *
 * The Tech Doc also gives a logarithmic profile based on friction velocity and
 * the Obukhov length. ALOHA uses the power law in most places because it is
 * numerically simpler and the difference is small over the height range that
 * matters here; HAZEL makes the same choice, and this is recorded as a known
 * simplification in engineLimitations.js.
 *
 * @param {number} referenceSpeed - measured wind speed (m/s)
 * @param {number} referenceHeight - height of the measurement (m)
 * @param {number} targetHeight - height wanted (m)
 * @param {string} stabilityClass - "A".."F"
 * @returns {number} wind speed at targetHeight (m/s)
 */
export function windSpeedAtHeight(
  referenceSpeed,
  referenceHeight,
  targetHeight,
  stabilityClass
) {
  if (referenceHeight <= 0 || targetHeight <= 0) {
    throw new Error("windSpeedAtHeight: heights must be greater than zero");
  }
  const n = WIND_PROFILE_EXPONENTS[stabilityClass];
  return referenceSpeed * Math.pow(targetHeight / referenceHeight, n);
}

/**
 * Obukhov length L for each Pasquill stability class, as a function of the
 * surface roughness z0 [TechDoc section 4.2.3]:
 *
 *   A: L = -11.4 z0^0.10    B: L = -26.0 z0^0.17    C: L = -123 z0^0.30
 *   D: L = infinity (neutral)
 *   E: L =  123 z0^0.30     F: L =  26.0 z0^0.17
 *
 * @param {string} stabilityClass - "A".."F"
 * @param {number} roughnessLength - z0, m
 * @returns {number} L, m (Infinity for class D)
 */
export function obukhovLength(stabilityClass, roughnessLength) {
  const table = {
    A: [-11.4, 0.1], B: [-26.0, 0.17], C: [-123, 0.3],
    E: [123, 0.3], F: [26.0, 0.17],
  };
  const entry = table[stabilityClass];
  if (!entry) return Infinity; // class D: neutral
  return entry[0] * Math.pow(roughnessLength, entry[1]);
}

/**
 * The Businger (1973) stability correction psi(zeta), zeta = z/L, used in
 * the surface-layer wind profile [TechDoc section 4.2.3]:
 *
 *   zeta < 0 (unstable): psi = 2 ln((1+a)/2) + ln((1+a^2)/2) - 2 arctan(a) + pi/2,
 *                        a = (1 - 15 zeta)^(1/4)
 *   zeta = 0 (neutral):  psi = 0
 *   zeta > 0 (stable):   psi = -4.7 zeta
 */
export function businger(zeta) {
  if (!Number.isFinite(zeta) || zeta === 0) return 0;
  if (zeta > 0) return -4.7 * zeta;
  const a = Math.pow(1 - 15 * zeta, 0.25);
  return 2 * Math.log((1 + a) / 2) + Math.log((1 + a * a) / 2) - 2 * Math.atan(a) + Math.PI / 2;
}

/**
 * Height at which the Gaussian model takes its transport wind, m.
 *
 * ADDED 2026-10-01. The Gaussian formula divides by "the" wind speed U, and
 * HAZEL used the 10 m wind. Direct-source ALOHA runs (ammonia, 0.1 kg/min,
 * classes A, D and F, open country and urban; methanol 27.9 kg/min, D)
 * showed that every one of ALOHA's zones is reproduced by the same formula
 * with a LOWER wind — by a factor that is constant at every distance within
 * a run (0.61 in F, 0.78 in D, 0.84 in A, 0.46 in F over urban terrain) —
 * and that all of these factors are the ratio of the Tech Doc's
 * stability-corrected logarithmic wind profile (section 4.2.3) at 3 m to
 * that at 10 m. 3 m is the height the Tech Doc itself uses for the wind
 * that carries the cloud when it sizes the confidence lines (section 4.5.3,
 * "U3 is the wind speed at 3 meters"). With it HAZEL's Gaussian zones in
 * those runs moved from 0.67-0.91x of ALOHA's to within a few percent.
 */
export const GAUSSIAN_TRANSPORT_HEIGHT = 3;

/**
 * Crosswind spread for a FLAMMABLE threshold (ADDED 2026-10-02).
 *
 * The rural sigma_y coefficients correspond to a 3-minute averaging time
 * (Tech Doc 4.3.1), and the Tech Doc states that horizontal dispersion
 * scales with averaging time to the 0.2 power and that ALOHA uses a
 * 10-second averaging time for flammable clouds (4.4.4). Hence
 * sigma_y(10 s) = sigma_y(3 min) * (10/180)^0.2 = 0.561 sigma_y. Applied to
 * the flash-fire zone and the flammable mass of a passive (Gaussian) cloud:
 * methane 1 kg/s, D 5 m/s (ALOHA 41 / 102 m at 60% / 10% LEL) went from
 * 29 / 72 m to 39 / 97 m.
 */
export const FLAMMABLE_SIGMA_Y_FACTOR = Math.pow(10 / 180, 0.2);

/*
 * AREA_SOURCE_NOTE (2026-10-01). ALOHA's Gaussian zones for an evaporating
 * puddle are shorter close to the source than a point source of the same
 * rate would give — methanol 27.9 kg/min, D: 38 m from a 500 m2 puddle
 * against 78 m from a point, converging by ~250 m — and HAZEL had treated
 * every source as a point. Adding the puddle's crosswind width as an initial
 * spread sigma0 = D/sqrt(2 pi) (the Gaussian with the same peak as a
 * uniform strip of width D), in quadrature with sigma_y, reproduces 24 ALOHA
 * zones from 1, 10, 200 and 500 m2 puddles (classes D and F, 1.5-10 m/s,
 * 10 m to 1 km) with an rms error of 7%; the outliers are the very nearest
 * zones of the largest puddles (13-38 m from 200-500 m2), where both tools
 * flag the result as unreliable.
 */

/**
 * The Tech Doc 4.2.3 surface-layer wind profile,
 * U(z) = (U* / k)[ln((z + z0)/z0) - psi(z/L)], scaled from the 10 m
 * reference to the height z. U* and k cancel in the ratio.
 *
 * @param {number} windSpeed10m - m/s
 * @param {number} height - z, m
 * @param {number} roughnessLength - z0, m
 * @param {string} stabilityClass - "A".."F"
 * @returns {number} m/s
 */
export function logProfileWindSpeed(windSpeed10m, height, roughnessLength, stabilityClass) {
  const z0 = roughnessLength > 0 ? roughnessLength : 0.03;
  const L = obukhovLength(stabilityClass, z0);
  const profile = (z) => Math.log((z + z0) / z0) - businger(Number.isFinite(L) ? z / L : 0);
  const ratio = profile(height) / profile(10);
  return Number.isFinite(ratio) && ratio > 0 ? windSpeed10m * ratio : windSpeed10m;
}

/**
 * The wind speed that carries a passive (Gaussian) plume: the Tech Doc 4.2.3
 * profile (logProfileWindSpeed()) at GAUSSIAN_TRANSPORT_HEIGHT, or at the
 * release height when the source is higher than that.
 *
 * ELEVATED SOURCES (2026-10-02): ALOHA comparisons E1/E2 (ammonia 1 kg/s,
 * D 5 m/s, open country, release at 10 and 30 m) are reproduced exactly
 * with the wind at the release height — 470 / 989 / 1993 m against ALOHA's
 * 470 / 990 / 2000, and 641 / 1621 m against 641 / 1600 — while the 3 m
 * wind gave 1.15-1.48x. Ground-level releases are unchanged.
 *
 * @param {number} windSpeed10m - m/s
 * @param {number} roughnessLength - z0, m
 * @param {string} stabilityClass - "A".."F"
 * @param {number} [releaseHeight] - m, source height above ground
 * @returns {number} m/s
 */
export function gaussianTransportWindSpeed(windSpeed10m, roughnessLength, stabilityClass, releaseHeight = 0) {
  const height = Math.max(GAUSSIAN_TRANSPORT_HEIGHT, Number(releaseHeight) || 0);
  return logProfileWindSpeed(windSpeed10m, height, roughnessLength, stabilityClass);
}

/* ========================================================================
   3. GAUSSIAN PROFILE TERMS
   ======================================================================== */

/**
 * Crosswind term g_y (Hanna et al. 1982): a normalised Gaussian in y.
 * At the plume centreline (y = 0) this reduces to 1 / (sqrt(2*pi) * sigmaY).
 */
function crosswindTerm(y, sy) {
  if (sy <= 0) return 0;
  return (1 / (Math.sqrt(2 * Math.PI) * sy)) * Math.exp(-(y * y) / (2 * sy * sy));
}

/**
 * Vertical term g_z, including ground reflection and, when present, reflection
 * from an inversion lid.
 *
 * The ground is treated as a perfect reflector: material that would disperse
 * below ground level is folded back upward. That is why the term contains two
 * exponentials rather than one — the real source plus a mirror image below
 * ground.
 *
 * When an inversion is present the stable layer aloft is modelled as a second
 * perfect reflector, and the cloud bounces between the two. The Tech Doc
 * truncates this at J = 5 reflections, and once the plume has grown tall
 * enough (sigmaZ >= 2 * inversionHeight) it switches to treating the
 * concentration as uniform through the mixed layer. Both behaviours are
 * reproduced here.
 *
 * @param {number} z - receptor height (m)
 * @param {number} sz - vertical dispersion parameter at this distance (m)
 * @param {number} releaseHeight - height of the release above ground (m)
 * @param {number|null} inversionHeight - height of the inversion lid (m), or null
 * @returns {number} value of g_z, in units of 1/m
 */
function verticalTerm(z, sz, releaseHeight, inversionHeight) {
  if (sz <= 0) return 0;

  const hs = releaseHeight;

  // Far downwind under an inversion the repeated reflections even out and the
  // cloud fills the mixed layer uniformly (Tech Doc section 4.3).
  if (inversionHeight && sz >= 2 * inversionHeight) {
    return 1 / inversionHeight;
  }

  const norm = 1 / (Math.sqrt(2 * Math.PI) * sz);
  const gauss = (d) => Math.exp(-(d * d) / (2 * sz * sz));

  // Source plus its ground-reflected image
  let total = gauss(z - hs) + gauss(z + hs);

  // Additional images from bouncing between the ground and the inversion lid
  if (inversionHeight) {
    const hi = inversionHeight;
    for (let n = 1; n <= INVERSION_REFLECTIONS; n++) {
      total +=
        gauss(z - 2 * n * hi - hs) +
        gauss(z + 2 * n * hi - hs) +
        gauss(z - 2 * n * hi + hs) +
        gauss(z + 2 * n * hi + hs);
    }
  }

  return norm * total;
}

/* ========================================================================
   4 & 5. CONCENTRATION
   ======================================================================== */

/**
 * Concentration for an infinite-duration (steady state) release — the term
 * written as chi in the Tech Doc:
 *
 *   chi(x,y,z) = (Q / U) * g_y(x,y) * g_z(x,z)
 *
 * @returns {number} mass concentration in kg/m^3
 */
export function steadyStateConcentration({
  x,
  y,
  z,
  releaseRate,
  windSpeed: givenWindSpeed,
  windSpeed10m,
  releaseHeight,
  stabilityClass,
  roughnessLength,
  inversionHeight = null,
  sourceWidth = 0,
  flammableAveraging = false,
}) {
  if (x <= 0) return 0;
  // A scenario object from the Source step carries only windSpeed10m; the
  // transport wind is derived from it (see gaussianTransportWindSpeed()).
  const windSpeed = givenWindSpeed ?? gaussianTransportWindSpeed(windSpeed10m, roughnessLength, stabilityClass, releaseHeight);

  // An evaporating puddle is an area source, not a point (2026-10-01): its
  // crosswind width D adds an initial spread equal to that of a Gaussian
  // with the same peak as a uniform strip of width D, sigma0 = D/sqrt(2 pi),
  // combined in quadrature with the atmospheric sigma_y. See
  // AREA_SOURCE_NOTE below.
  const sy = Math.hypot(
    sigmaY(x, stabilityClass) * (flammableAveraging ? FLAMMABLE_SIGMA_Y_FACTOR : 1),
    (sourceWidth || 0) / Math.sqrt(2 * Math.PI)
  );
  const sz = sigmaZ(x, stabilityClass, roughnessLength);

  return (
    (releaseRate / windSpeed) *
    crosswindTerm(y, sy) *
    verticalTerm(z, sz, releaseHeight, inversionHeight)
  );
}

/**
 * Peak concentration reached at a point during a release of finite duration.
 *
 * A release lasting t_r seconds never reaches the full steady-state value at
 * distances the cloud has not had time to saturate. Palazzi et al. (1982), the
 * formulation ALOHA adopts, expresses the concentration at position x and time
 * t as a pair of error functions describing the leading and trailing edges of
 * the cloud:
 *
 *   C(x,t) = chi/2 * [ erf((x - U(t - t_r)) / (sigmaX * sqrt2))
 *                      - erf((x - U t) / (sigmaX * sqrt2)) ]
 *
 * FIX (2026-09-27): this file previously evaluated that expression at a FIXED
 * time, t = t_r (the moment the source shuts off), on the reasoning that "the
 * largest value at a given x occurs at t = t_r". That reasoning only holds at
 * x = 0. For any x > 0 the cloud is still advecting downwind after the source
 * shuts off, so the moment of peak concentration at a station further out
 * comes LATER — solving dC/dt = 0 for t at fixed x gives t* = x/U + t_r/2 (the
 * instant the cloud's own midpoint, not its trailing edge, passes the
 * station), not t = t_r. Evaluating at the wrong fixed time made concentration
 * collapse to numerically zero once x exceeded roughly U*t_r plus a couple of
 * sigmaX — for a 10-minute, 5 m/s release that is only ~3 km downwind — even
 * though the cloud plainly keeps travelling well past that point. Found by
 * comparing HAZEL against a real ALOHA run (chlorine, Eindhoven, 2026-09-27)
 * whose lower-threshold (AEGL-1/AEGL-2) threat distances ran past 6 miles,
 * far beyond where HAZEL's old duration factor had already fallen to ~0.
 *
 * Substituting t* = x/U + t_r/2 back into C(x,t) collapses the two-erf
 * expression to a single term (both arguments become +-U*t_r/(2*sigmaX*sqrt2),
 * and erf is odd):
 *
 *   durationFactor(x) = erf( (U * t_r) / (2 * sigmaX(x) * sqrt2) )
 *
 * This depends on x only through sigmaX(x) (which grows with distance), not
 * on x directly relative to the release length U*t_r — matching the physical
 * picture: the peak stays near the full steady-state value for as long as the
 * along-wind turbulent smearing sigmaX(x) is small compared to the cloud's own
 * length U*t_r, and only tapers once sigmaX(x) grows to be comparable to or
 * larger than that length, however far downwind that happens to be.
 *
 * As t_r grows (a longer release) or x shrinks (closer to the source, less
 * time for sigmaX to grow) the factor approaches 1 and the result converges
 * on the steady state — the same useful property the original had, still
 * true here (see weatherTests.js's/gaussianTests.js's regression checks).
 *
 * Note this returns the PEAK concentration, not a time-averaged one. Levels of
 * Concern such as AEGL and ERPG are defined over an averaging period (usually
 * 60 minutes), so comparing a peak against them is conservative: it flags a
 * location as inside the threat zone if the concentration is ever high enough,
 * even briefly. That matches ALOHA's stated bias toward overestimating rather
 * than underestimating threat distances.
 *
 * @returns {number} peak mass concentration in kg/m^3
 */
export function peakConcentration(rawParams) {
  // Resolve the transport wind once (see steadyStateConcentration()).
  const params = {
    ...rawParams,
    windSpeed: rawParams.windSpeed ??
      gaussianTransportWindSpeed(rawParams.windSpeed10m, rawParams.roughnessLength, rawParams.stabilityClass, rawParams.releaseHeight),
  };
  const { x, releaseDuration, windSpeed, stabilityClass, releaseSteps } = params;
  if (x <= 0) return 0;

  // A release that varies in time (puddle, tank) arrives as up to five
  // steady steps (2026-10-01; Tech Doc 4.3: "a time-dependent release is
  // modeled as series of five finite-duration steady-state releases ... The
  // concentration at a point in space and time is found by summing the
  // contributions from each cloud"). The Gaussian solution is linear in the
  // release rate and every step has the same spatial shape, so the peak over
  // time is the unit-rate plume times the largest time-weighted sum of the
  // step rates at this distance.
  if (Array.isArray(releaseSteps) && releaseSteps.length > 1) {
    const unit = steadyStateConcentration({ ...params, releaseRate: 1 });
    if (unit === 0) return 0;
    return unit * peakEffectiveRate(x, releaseSteps, windSpeed, stabilityClass);
  }

  const chi = steadyStateConcentration(params);
  if (chi === 0) return 0;

  const sx = sigmaX(x, stabilityClass);
  if (sx <= 0) return chi;

  const releaseLength = windSpeed * releaseDuration;
  const durationFactor = erf(releaseLength / (2 * sx * Math.SQRT2));

  return chi * durationFactor;
}

/** Per-steps-array cache of peakEffectiveRate() by distance. */
const effectiveRateCache = new WeakMap();

/**
 * Largest value over time of sum_k rate_k * w_k(x, t), where w_k is the
 * Palazzi along-wind window of step k (the same erf construction as the
 * single-step duration factor above):
 *
 *   w_k(x, t) = 1/2 [ erf((U(t - t_k) - x) / (sqrt2 sigma_x))
 *                   - erf((U(t - t_k - dt_k) - x) / (sqrt2 sigma_x)) ]
 *
 * @returns {number} kg/s, the rate a steady plume would need to give the same peak
 */
export function peakEffectiveRate(x, releaseSteps, windSpeed, stabilityClass) {
  let byDistance = effectiveRateCache.get(releaseSteps);
  if (!byDistance) {
    byDistance = new Map();
    effectiveRateCache.set(releaseSteps, byDistance);
  }
  const key = `${x}|${windSpeed}|${stabilityClass}`;
  const cached = byDistance.get(key);
  if (cached !== undefined) return cached;

  const s = Math.max(sigmaX(x, stabilityClass), 1e-6) * Math.SQRT2;
  const total = (t) => {
    let sum = 0;
    for (const step of releaseSteps) {
      const front = windSpeed * (t - step.startTime) - x;
      const back = windSpeed * (t - step.startTime - step.duration) - x;
      sum += step.rate * 0.5 * (erf(front / s) - erf(back / s));
    }
    return sum;
  };
  const end = Math.max(...releaseSteps.map((st) => st.startTime + st.duration));
  const tStart = Math.max(0, (x - 4 * s) / windSpeed);
  const tEnd = (x + 4 * s) / windSpeed + end;
  const samples = 240;
  const h = (tEnd - tStart) / samples;
  let best = -1, bestT = tStart;
  for (let i = 0; i <= samples; i++) {
    const t = tStart + i * h;
    const v = total(t);
    if (v > best) { best = v; bestT = t; }
  }
  let lo = Math.max(tStart, bestT - h), hi = Math.min(tEnd, bestT + h);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 30; i++) {
    const m1 = hi - g * (hi - lo), m2 = lo + g * (hi - lo);
    if (total(m1) >= total(m2)) hi = m2; else lo = m1;
  }
  const result = Math.max(best, total((lo + hi) / 2));
  if (byDistance.size > 5000) byDistance.clear();
  byDistance.set(key, result);
  return result;
}

/* ========================================================================
   UNIT CONVERSION
   ======================================================================== */

/**
 * Converts a mass concentration to parts per million by volume.
 *
 * Levels of Concern for gases are published in ppm, while the dispersion model
 * works in kg/m^3, so this conversion sits between the two. It assumes ideal
 * gas behaviour:
 *
 *   ppm = (C / M) * (R * T / P) * 1e6
 *
 * Sanity check used in the tests: chlorine (M = 70.9 g/mol) at 25 degrees C
 * and 1 atm gives 1 ppm = 2.90 mg/m^3, which matches the conversion factor
 * published in the NIOSH Pocket Guide.
 *
 * @param {number} massConcentration - kg/m^3
 * @param {number} molecularWeight - g/mol
 * @param {number} temperature - K
 * @param {number} [pressure] - Pa
 * @returns {number} concentration in ppm (v/v)
 */
export function massConcentrationToPpm(
  massConcentration,
  molecularWeight,
  temperature,
  pressure = STANDARD_PRESSURE
) {
  const molesPerCubicMetre = (massConcentration * 1000) / molecularWeight;
  const totalMolesPerCubicMetre = pressure / (UNIVERSAL_GAS_CONSTANT * temperature);
  return (molesPerCubicMetre / totalMolesPerCubicMetre) * 1e6;
}

/** Inverse of massConcentrationToPpm — used to turn a Level of Concern into kg/m^3. */
export function ppmToMassConcentration(
  ppm,
  molecularWeight,
  temperature,
  pressure = STANDARD_PRESSURE
) {
  const totalMolesPerCubicMetre = pressure / (UNIVERSAL_GAS_CONSTANT * temperature);
  const molesPerCubicMetre = (ppm / 1e6) * totalMolesPerCubicMetre;
  return (molesPerCubicMetre * molecularWeight) / 1000;
}

/* ========================================================================
   6. THREAT ZONE
   ======================================================================== */

/**
 * Validates a scenario before any numbers are produced.
 *
 * This deliberately throws rather than returning a best-effort answer. A
 * dispersion figure carries an air of authority regardless of whether the
 * model applies, so when the scenario falls outside the model's stated range
 * the right output is an explanation, not a number.
 *
 * @returns {string[]} list of problems; empty array means the scenario is usable
 */
export function validateScenario({
  windSpeed10m,
  releaseRate,
  releaseDuration,
  molecularWeight,
  temperature,
}) {
  const problems = [];

  if (!Number.isFinite(windSpeed10m) || windSpeed10m < MIN_WIND_SPEED) {
    problems.push(
      `Wind speed is ${windSpeed10m} m/s. The Gaussian model is not applicable below ` +
        `${MIN_WIND_SPEED} m/s at 10 m: in calm conditions the plume is not ` +
        `wind-dominated and the model has no valid solution.`
    );
  }

  if (!Number.isFinite(releaseRate) || releaseRate <= 0) {
    problems.push("Release rate must be greater than zero.");
  }

  if (!Number.isFinite(releaseDuration) || releaseDuration <= 0) {
    problems.push("Release duration must be greater than zero.");
  } else if (releaseDuration > MAX_RELEASE_DURATION) {
    problems.push(
      `Release duration is ${Math.round(releaseDuration / 60)} minutes. The model ` +
        `covers releases up to ${MAX_RELEASE_DURATION / 60} minutes; beyond that the ` +
        `assumption of steady weather over the whole release stops being reasonable.`
    );
  }

  if (!Number.isFinite(molecularWeight) || molecularWeight <= 0) {
    problems.push("Molecular weight must be greater than zero.");
  }

  if (!Number.isFinite(temperature) || temperature <= 0) {
    problems.push("Temperature must be given in kelvin and be greater than zero.");
  }

  return problems;
}

/**
 * Computes the threat zone for one Level of Concern: how far downwind the
 * ground-level centreline concentration stays above the threshold, and the
 * outline of the affected area.
 *
 * The search runs in two stages. First a coarse logarithmic scan brackets the
 * distance at which concentration crosses the threshold — necessary because
 * threat distances range from metres to tens of kilometres depending on the
 * scenario. Then a bisection narrows that bracket to within half a metre.
 *
 * @param {object} scenario
 * @param {number} scenario.releaseRate - kg/s entering the atmosphere
 * @param {number} scenario.releaseDuration - seconds
 * @param {number} scenario.releaseHeight - m above ground
 * @param {number} scenario.windSpeed10m - m/s at 10 m
 * @param {string} scenario.stabilityClass - "A".."F"
 * @param {number} scenario.roughnessLength - surface roughness z0, m
 * @param {number|null} [scenario.inversionHeight] - m, or null when absent
 * @param {number} scenario.molecularWeight - g/mol
 * @param {number} scenario.temperature - K
 * @param {number} scenario.levelOfConcernPpm - the threshold, in ppm
 * @param {number} [scenario.maxSearchDistance] - m, search ceiling
 * @returns {{ thresholdExceeded: boolean, maxDownwindDistance: number, footprint: Array<{x:number,y:number}> }}
 */
export function findThreatZone(scenario) {
  const {
    releaseRate,
    releaseDuration,
    releaseHeight = 0,
    windSpeed10m,
    stabilityClass,
    roughnessLength,
    inversionHeight = null,
    molecularWeight,
    temperature,
    levelOfConcernPpm,
    maxSearchDistance = 50000,
    sourceWidth = 0,
    releaseSteps,
    flammableAveraging = false,
  } = scenario;

  // The transport wind: the Tech Doc 4.2.3 profile at 3 m, not the 10 m
  // reference wind (changed 2026-10-01 — see gaussianTransportWindSpeed()).
  const windSpeed = gaussianTransportWindSpeed(windSpeed10m, roughnessLength, stabilityClass, releaseHeight);

  const thresholdKgPerM3 = ppmToMassConcentration(
    levelOfConcernPpm,
    molecularWeight,
    temperature
  );

  const concentrationAt = (x, y) =>
    peakConcentration({
      x,
      y,
      z: 0, // ground level — where people breathe, and the worst case for a surface release
      releaseRate,
      releaseDuration,
      releaseHeight,
      windSpeed,
      stabilityClass,
      roughnessLength,
      inversionHeight,
      sourceWidth,
      releaseSteps,
      flammableAveraging,
    });

  const exceedsAt = (x, y = 0) => concentrationAt(x, y) >= thresholdKgPerM3;

  // --- Stage 1: coarse logarithmic scan to bracket the crossing point ---
  // Starting at 1 m and stepping by a factor of 1.5 covers 1 m to 50 km in
  // about 27 steps.
  let insideDistance = 0;
  let outsideDistance = 0;
  let probe = 1;

  while (probe <= maxSearchDistance) {
    if (exceedsAt(probe)) {
      insideDistance = probe;
    } else if (insideDistance > 0) {
      outsideDistance = probe;
      break;
    }
    probe *= 1.5;
  }

  if (insideDistance === 0) {
    // The threshold is never reached anywhere downwind. That is a legitimate
    // and useful result — it means this Level of Concern is not exceeded.
    return { thresholdExceeded: false, maxDownwindDistance: 0, footprint: [] };
  }

  if (outsideDistance === 0) {
    // Still above the threshold at the search ceiling. Report the ceiling and
    // let the caller decide how to present a plume that runs off the map.
    return {
      thresholdExceeded: true,
      maxDownwindDistance: maxSearchDistance,
      reachedSearchLimit: true,
      footprint: [],
    };
  }

  // --- Stage 2: bisection to the exact crossing distance ---
  // Tolerance relative to the zone size (at most 0.5 m): a fixed 0.5 m,
  // always rounded inwards, shortened 20-60 m zones by up to 2% and their
  // half-widths (bisected the same way in buildFootprint()) by up to 10%.
  // 2026-10-02.
  const maxDownwindDistance = bisectBoundary(
    (x) => exceedsAt(x),
    insideDistance,
    outsideDistance,
    boundaryTolerance(outsideDistance)
  );

  // --- Outline of the affected area ---
  // At each of a series of downwind distances, find the widest crosswind offset
  // still above the threshold. Those points, mirrored about the centreline,
  // form the threat zone polygon that the results view draws.
  const footprint = buildFootprint(
    maxDownwindDistance,
    (x, y) => concentrationAt(x, y) >= thresholdKgPerM3
  );

  return { thresholdExceeded: true, maxDownwindDistance, footprint };
}

/**
 * Builds the threat-zone polygon by sampling the crosswind edge at a series
 * of downwind stations.
 *
 * The stations are NOT evenly spaced in x. They follow a cosine ("Chebyshev")
 * spacing instead, clustering samples near both x=0 and x=maxDistance:
 *
 *     x_i = maxDistance * (1 - cos(pi * i / steps)) / 2
 *
 * With plain even spacing, the number of samples near the source stays
 * fixed at maxDistance/steps regardless of how far the zone reaches — for a
 * short zone that resolves the near-source "neck" (where the plume is
 * still narrow) just fine, but for a zone reaching kilometres downwind,
 * that same first step can land tens or hundreds of metres out, well past
 * where the neck has already widened. The polygon's first recorded point
 * is then already wide, and the true narrow-wide-narrow "lens" silhouette
 * (see the Gaussian dispersion validation notes) renders instead as a
 * wedge that looks wide from the start — a resolution artefact, not a
 * change in the underlying physics. Cosine spacing keeps stations dense
 * near x=0 (and, symmetrically, near the far tip, which narrows the same
 * way) no matter how far out maxDistance is, at no extra cost: the point
 * count stays exactly `steps` either way.
 *
 * @param {number} maxDistance - furthest downwind extent of the zone (m)
 * @param {(x: number, y: number) => boolean} exceeds - threshold test
 * @param {number} [steps] - number of slices along the plume
 * @returns {Array<{x: number, y: number}>}
 */
function boundaryTolerance(scale) {
  return Math.min(0.5, Math.max(0.005, scale * 1e-3));
}

function buildFootprint(maxDistance, exceeds, steps = 40) {
  const upperEdge = [];
  const lowerEdge = [];

  for (let i = 1; i <= steps; i++) {
    const x = (maxDistance * (1 - Math.cos((Math.PI * i) / steps))) / 2;

    // Find an offset that is outside the plume, to bracket the bisection.
    let outer = 1;
    while (exceeds(x, outer) && outer < maxDistance * 2) {
      outer *= 2;
    }

    if (!exceeds(x, 0)) continue; // centreline itself is below threshold here

    const edgeY = bisectBoundary((y) => exceeds(x, y), 0, outer, boundaryTolerance(outer));

    upperEdge.push({ x, y: edgeY });
    lowerEdge.push({ x, y: -edgeY });
  }

  // Close the polygon: out along one side, back along the other.
  return [...upperEdge, ...lowerEdge.reverse()];
}
