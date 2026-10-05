/**
 * engineViewFactor.js
 * -------------------
 * Numerical radiative view factor integration, shared by the pool fire and
 * jet fire models (enginePoolFire.js, engineJetFire.js), both of which need
 * it for a flame surface with no simple closed-form solution.
 *
 * Source: ALOHA 5.4.4 Technical Documentation (NOAA TM NOS OR&R 43),
 * sections 6.4.2 and 6.5.2, after Sparrow and Cess (1978):
 *
 *     dF = (dA_i / A_j) * INTEGRAL_over_Aj [ cos(beta_i)*cos(beta_j) / (pi*r^2) ] dA_j
 *
 * where A_j is the radiating flame surface, dA_i the receiving element,
 * beta_i the angle at the receiver between its normal and the line to the
 * flame point, beta_j the equivalent angle at the flame surface, and r the
 * distance between them.
 *
 * The Tech Doc evaluates this by dividing the flame surface into tiles,
 * summing the integrand at each tile's centre, and repeating for three
 * mutually perpendicular receiver orientations to find the worst case:
 *
 *     f = sqrt(f1^2 + f2^2 + f3^2)
 *
 * with an explicit note (both 6.4.2 and 6.5.2) that because f1, f2, f3 feed
 * into a MAXIMUM view factor rather than a true one, tiles facing away from
 * the receiver are NOT excluded the way a physically exact view factor
 * calculation would exclude them. This module follows that instruction
 * literally: every tile contributes to every orientation's sum, sign
 * included, with no clipping.
 *
 * VALIDATION
 * ----------
 * There is no ALOHA worked example in this project's document set to check
 * a jet or pool fire result against. This module's own tests instead
 * validate the numerical method itself against a case with a genuine
 * closed-form answer: a flat disk viewed on-axis, F = R^2/(R^2+H^2) (a
 * standard result — see e.g. Incropera, Fundamentals of Heat and Mass
 * Transfer). A disk was chosen deliberately over a closed shape like a
 * sphere: for ANY closed surface fully surrounding nothing (an external
 * point outside it), the unclipped kernel used here integrates to exactly
 * zero by the same mathematics as Gauss's law — the near side's
 * contribution and the far side's are equal and opposite by construction,
 * regardless of whether the implementation is correct. An early version of
 * this module's tests tried exactly that (tiling a sphere and comparing
 * against engineBleve.js's exact fireballViewFactor formula) and found
 * near-zero agreement — not a bug, but a case that cannot validate
 * anything, because the "unclipped" method is mathematically guaranteed to
 * return approximately zero there no matter what. The disk, and the
 * cylinder and frustum shapes this module actually generates for real
 * flames, are open surfaces without that pathology.
 */

/** The three mutually perpendicular receiver orientations Tech Doc 6.4.2 /
 *  6.5.2 specify, aligned with this module's coordinate convention: x
 *  downwind, y crosswind, z vertical. */
const ORTHOGONAL_ORIENTATIONS = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/**
 * Computes the maximum view factor from a tiled flame surface to a point
 * receptor, per Tech Doc 6.4.2 / 6.5.2.
 *
 * @param {Array<{position: [number,number,number], normal: [number,number,number], area: number}>} tiles
 * @param {[number,number,number]} receptorPoint - m, in the same frame as the tiles
 * @returns {{ f1: number, f2: number, f3: number, viewFactor: number }}
 */
export function computeViewFactor(tiles, receptorPoint) {
  const sums = ORTHOGONAL_ORIENTATIONS.map(() => 0);

  for (const tile of tiles) {
    const dx = receptorPoint[0] - tile.position[0];
    const dy = receptorPoint[1] - tile.position[1];
    const dz = receptorPoint[2] - tile.position[2];
    const r2 = dx * dx + dy * dy + dz * dz;
    if (r2 < 1e-9) continue; // receptor coincides with a tile centre — skip a singular term

    const r = Math.sqrt(r2);
    // Direction from the tile to the receptor.
    const dHatX = dx / r, dHatY = dy / r, dHatZ = dz / r;

    const cosBetaJ = tile.normal[0] * dHatX + tile.normal[1] * dHatY + tile.normal[2] * dHatZ;
    // Only flame surface that faces the receptor can radiate to it
    // (CHANGED 2026-10-01). Tiles on the far side of the flame used to be
    // summed too, with a negative cos(beta_j); for a closed flame surface
    // that cancelled much of the near side and roughly halved the view
    // factor. ALOHA comparisons (toluene pool fires 20 and 200 m2, propane
    // jet fires) are reproduced only with those tiles left out: jet fires
    // within 5%, pool fires within ~10%, against 0.25-0.6x before.
    if (cosBetaJ <= 0) continue;

    for (let i = 0; i < ORTHOGONAL_ORIENTATIONS.length; i++) {
      const orientation = ORTHOGONAL_ORIENTATIONS[i];
      // beta_i is measured from the receiver's normal to the line back
      // toward the flame point, i.e. along -dHat.
      const cosBetaI = -(orientation[0] * dHatX + orientation[1] * dHatY + orientation[2] * dHatZ);
      sums[i] += (tile.area * cosBetaI * cosBetaJ) / (Math.PI * r2);
    }
  }

  const [f1, f2, f3] = sums;
  return { f1, f2, f3, viewFactor: Math.sqrt(f1 * f1 + f2 * f2 + f3 * f3) };
}

/**
 * Builds tiles over the lateral surface of a tilted cylinder standing on
 * the ground — the pool fire flame shape (Tech Doc 6.5.2). The jet fire
 * model reuses this too, as a documented approximation to its more complex
 * frustum shape (see engineJetFire.js for why).
 *
 * The cylinder's base centre is at the origin; its axis tilts by `tiltAngle`
 * (radians from vertical) toward +x (the downwind direction in this
 * module's coordinate convention).
 *
 * Implements the footnote in Tech Doc 6.5.2: for the row of tiles at the
 * base of the flame, the point used for the integration is on the ground
 * (t=0), not that row's own midpoint — stated there as improving accuracy
 * for observers near the surface.
 *
 * @param {number} diameter - m
 * @param {number} height - m, measured along the (tilted) axis
 * @param {number} tiltAngle - radians from vertical
 * @param {number} [circumferentialDivisions]
 * @param {number} [axialDivisions]
 * @returns {Array<{position:[number,number,number], normal:[number,number,number], area:number}>}
 */
export function tileTiltedCylinder(
  diameter,
  height,
  tiltAngle,
  circumferentialDivisions = 40,
  axialDivisions = 25
) {
  const radius = diameter / 2;
  // Axis direction (tilting in the x-z plane, toward downwind +x).
  const axis = [Math.sin(tiltAngle), 0, Math.cos(tiltAngle)];
  // Two vectors perpendicular to the axis, spanning the circular cross-section.
  const e1 = [Math.cos(tiltAngle), 0, -Math.sin(tiltAngle)];
  const e2 = [0, 1, 0];

  const tileArea = ((2 * Math.PI * radius) / circumferentialDivisions) * (height / axialDivisions);
  const tiles = [];

  for (let i = 0; i < axialDivisions; i++) {
    const tMid = (i + 0.5) * (height / axialDivisions);
    // Tech Doc footnote: the base row's point is on the ground, not its
    // midpoint — improves accuracy for a receiver near the flame's base.
    const t = i === 0 ? 0 : tMid;

    for (let j = 0; j < circumferentialDivisions; j++) {
      const phiMid = (j + 0.5) * ((2 * Math.PI) / circumferentialDivisions);
      const cosPhi = Math.cos(phiMid);
      const sinPhi = Math.sin(phiMid);

      const normal = [
        cosPhi * e1[0] + sinPhi * e2[0],
        cosPhi * e1[1] + sinPhi * e2[1],
        cosPhi * e1[2] + sinPhi * e2[2],
      ];

      const position = [
        t * axis[0] + radius * normal[0],
        t * axis[1] + radius * normal[1],
        t * axis[2] + radius * normal[2],
      ];

      tiles.push({ position, normal, area: tileArea });
    }
  }

  return tiles;
}

/**
 * Builds tiles over the lateral surface of a tilted, TAPERED cone frustum —
 * the jet fire flame shape (Chamberlain 1987, Chem Eng Res Des 65, 299-309;
 * cross-checked against ALOHA Tech Doc 6.4.2), used in place of the
 * average-diameter cylinder approximation engineJetFire.js used previously.
 *
 * SPATIAL PLACEMENT — VERIFIED AGAINST CHAMBERLAIN (1987)
 * ---------------------------------------------------------
 * Confirmed directly against Chamberlain's Figure 1 and sections 4.1.3-4.1.4
 * (2026-09-22, from a good-quality scan of the original paper): the
 * frustum's own axis is tilted by `tiltAngle` from the hole axis, meeting
 * it at point P; the lift-off distance `liftOff` (b) is measured along the
 * HOLE AXIS from the nozzle to P; and the frustum itself — base to tip —
 * runs `length` (R_L) further along the frustum axis from P. That is
 * exactly the placement this function already used.
 *
 * What was wrong until now was not the placement but the R_L formula it
 * was fed: engineJetFire.js's frustumSlantLength() had copied the ALOHA
 * Tech Doc's version of the formula, which has a PLUS sign under its
 * square root. Chamberlain's original paper (p. 303) has MINUS there. The
 * plus-sign version is, in fact, not geometrically realisable by this (or
 * any) simple two-segment placement for a general tilt angle — which is
 * exactly why earlier attempts to reconcile the placement with the Tech
 * Doc's formula kept failing. With the corrected minus-sign formula now in
 * engineJetFire.js, the placement below is fully consistent with it.
 *
 * @param {number} baseDiameter - m, W1
 * @param {number} tipDiameter - m, W2
 * @param {number} length - m, the frustum's own slant length, R_L
 * @param {number} liftOff - m, distance from the nozzle to the base, along the tilted axis
 * @param {number} tiltAngle - radians from vertical
 * @param {number} [circumferentialDivisions]
 * @param {number} [axialDivisions]
 * @returns {Array<{position:[number,number,number], normal:[number,number,number], area:number}>}
 */
export function tileTiltedFrustum(
  baseDiameter,
  tipDiameter,
  length,
  liftOff,
  tiltAngle,
  circumferentialDivisions = 40,
  axialDivisions = 25
) {
  const r0 = baseDiameter / 2;
  const r1 = tipDiameter / 2;
  const axis = [Math.sin(tiltAngle), 0, Math.cos(tiltAngle)];
  const e1 = [Math.cos(tiltAngle), 0, -Math.sin(tiltAngle)];
  const e2 = [0, 1, 0];

  // The lateral surface of a cone is slanted relative to its axis; a ring
  // of "height" dt along the axis has slant length dt*slantFactor, where
  // slantFactor = sqrt(1 + ((r1-r0)/length)^2) — this reduces to 1 for a
  // cylinder (r0=r1), consistent with tileTiltedCylinder() above.
  const slantFactor = Math.sqrt(1 + Math.pow((r1 - r0) / length, 2));

  const tiles = [];

  for (let i = 0; i < axialDivisions; i++) {
    const t0 = liftOff + (i / axialDivisions) * length;
    const t1 = liftOff + ((i + 1) / axialDivisions) * length;
    const tMid = (t0 + t1) / 2;
    const rMid = r0 + (r1 - r0) * ((tMid - liftOff) / length);
    const tileArea = ((2 * Math.PI * rMid) / circumferentialDivisions) * (t1 - t0) * slantFactor;

    for (let j = 0; j < circumferentialDivisions; j++) {
      const phiMid = (j + 0.5) * ((2 * Math.PI) / circumferentialDivisions);
      const cosPhi = Math.cos(phiMid);
      const sinPhi = Math.sin(phiMid);

      // The radial direction, not the true cone-surface normal (which
      // would tilt slightly inward/outward by the cone's own half-angle) —
      // the same level of approximation tileTiltedCylinder() already uses,
      // and a small correction for a taper this gradual over 25 axial
      // divisions.
      const normal = [
        cosPhi * e1[0] + sinPhi * e2[0],
        cosPhi * e1[1] + sinPhi * e2[1],
        cosPhi * e1[2] + sinPhi * e2[2],
      ];

      const position = [
        tMid * axis[0] + rMid * normal[0],
        tMid * axis[1] + rMid * normal[1],
        tMid * axis[2] + rMid * normal[2],
      ];

      tiles.push({ position, normal, area: tileArea });
    }
  }

  return tiles;
}
