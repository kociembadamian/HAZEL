/**
 * engineTankGeometry.js
 * ---------------------
 * Geometry of a tank: how much liquid it holds at a given level, where the
 * liquid surface sits, and how much of a hole lies beneath it.
 *
 * This is separated from the release physics because it is pure geometry and
 * can be checked exactly — a horizontal cylinder half full holds exactly half
 * its volume, a sphere filled to its diameter holds all of it — whereas the
 * flow models can only be checked against other models. Errors here would be
 * invisible downstream: the release rate would simply be wrong, plausibly.
 *
 * Deliberately NOT included: any catalogue of standard tank sizes. ADR does
 * not standardise tank capacities — it sets minimums and leaves the rest to
 * the manufacturer — so a built-in list of "typical" road tankers would be
 * wrong somewhere from the start and would go stale the moment the agreement
 * added a new vessel type. The user gives the dimensions, as they do in ALOHA.
 */

/** Tank shapes HAZEL can describe. */
export const TANK_SHAPES = {
  horizontalCylinder: "Horizontal cylinder",
  verticalCylinder: "Vertical cylinder",
  sphere: "Sphere",
};

/**
 * Total internal volume of a tank.
 *
 * @param {object} tank
 * @param {string} tank.shape - key of TANK_SHAPES
 * @param {number} tank.diameter - m
 * @param {number} [tank.length] - m; required for cylinders, ignored for spheres
 * @returns {number} m^3
 */
export function tankVolume({ shape, diameter, length }) {
  const radius = diameter / 2;

  switch (shape) {
    case "sphere":
      return (4 / 3) * Math.PI * Math.pow(radius, 3);
    case "verticalCylinder":
    case "horizontalCylinder":
      if (!length) throw new Error("tankVolume: a cylinder needs a length");
      return Math.PI * radius * radius * length;
    default:
      throw new Error(`tankVolume: unknown shape "${shape}"`);
  }
}

/**
 * Liquid volume held at a given depth, measured from the lowest point of the
 * tank.
 *
 * The horizontal cylinder is the non-obvious case: its cross-section at any
 * depth is a circular segment, whose area is
 *
 *     A = r^2 * arccos((r - h) / r) - (r - h) * sqrt(2rh - h^2)
 *
 * This is why a horizontal road tanker's contents gauge is not linear, and
 * why treating it as linear would misstate the driving head on a low hole.
 *
 * @param {object} tank
 * @param {number} depth - liquid depth from the bottom, m
 * @returns {number} m^3
 */
export function liquidVolumeAtDepth(tank, depth) {
  const { shape, diameter, length } = tank;
  const radius = diameter / 2;
  const h = Math.max(0, Math.min(depth, shape === "verticalCylinder" ? Infinity : diameter));

  switch (shape) {
    case "verticalCylinder": {
      const clamped = Math.max(0, Math.min(depth, length));
      return Math.PI * radius * radius * clamped;
    }

    case "horizontalCylinder": {
      if (h <= 0) return 0;
      if (h >= diameter) return tankVolume(tank);
      const segmentArea =
        radius * radius * Math.acos((radius - h) / radius) -
        (radius - h) * Math.sqrt(2 * radius * h - h * h);
      return segmentArea * length;
    }

    case "sphere": {
      if (h <= 0) return 0;
      if (h >= diameter) return tankVolume(tank);
      // Spherical cap: V = pi * h^2 * (3r - h) / 3
      return (Math.PI * h * h * (3 * radius - h)) / 3;
    }

    default:
      throw new Error(`liquidVolumeAtDepth: unknown shape "${shape}"`);
  }
}

/**
 * The inverse: liquid depth that corresponds to a given volume.
 *
 * For the vertical cylinder this inverts analytically. For the horizontal
 * cylinder and the sphere the relationship cannot be inverted in closed form,
 * so a bisection is used. Bisection rather than Newton's method because the
 * function is monotonic and bounded, which makes bisection unconditionally
 * convergent — and because the tolerance needed here (a tenth of a
 * millimetre) is reached in about 25 iterations, which is nothing.
 *
 * @returns {number} depth in m
 */
export function depthForLiquidVolume(tank, volume) {
  const total = tankVolume(tank);
  if (volume <= 0) return 0;
  if (volume >= total) {
    return tank.shape === "verticalCylinder" ? tank.length : tank.diameter;
  }

  if (tank.shape === "verticalCylinder") {
    const radius = tank.diameter / 2;
    return volume / (Math.PI * radius * radius);
  }

  const maxDepth = tank.diameter;
  let low = 0;
  let high = maxDepth;

  for (let i = 0; i < 60 && high - low > 1e-4; i++) {
    const mid = (low + high) / 2;
    if (liquidVolumeAtDepth(tank, mid) < volume) low = mid;
    else high = mid;
  }

  return (low + high) / 2;
}

/**
 * How much of a hole lies below the liquid surface, and therefore how much of
 * it passes liquid rather than vapour.
 *
 * The Tech Doc (section 3.4.4.1) defines the effective area A_f as "the area
 * of the hole times the fraction of the hole lying below the level of the
 * liquid". A hole straddling the liquid surface passes liquid through its
 * lower part and vapour through its upper part, and the release rate changes
 * continuously as the level falls past it — which matters because a partly
 * submerged hole is the common case once a tank has been draining for a while.
 *
 * Circular holes are treated as circular segments, matching the geometry;
 * rectangular holes scale linearly with the submerged fraction of their height.
 *
 * @param {object} hole
 * @param {string} hole.shape - "circular" | "rectangular"
 * @param {number} hole.diameter - m, for circular holes
 * @param {number} hole.width - m, for rectangular holes
 * @param {number} hole.height - m, for rectangular holes
 * @param {number} hole.heightAboveBottom - m, the bottom edge of the hole
 * @param {number} liquidDepth - m, current liquid depth in the tank
 * @returns {{ submergedArea: number, totalArea: number, fullySubmerged: boolean, dry: boolean }}
 */
export function submergedHoleArea(hole, liquidDepth) {
  const bottom = hole.heightAboveBottom;

  if (hole.shape === "rectangular") {
    const totalArea = hole.width * hole.height;
    const submergedHeight = Math.max(0, Math.min(hole.height, liquidDepth - bottom));
    return {
      submergedArea: hole.width * submergedHeight,
      totalArea,
      fullySubmerged: submergedHeight >= hole.height - 1e-9,
      dry: submergedHeight <= 0,
    };
  }

  // Circular hole
  const radius = hole.diameter / 2;
  const totalArea = Math.PI * radius * radius;
  const submergedHeight = liquidDepth - bottom;

  if (submergedHeight <= 0) {
    return { submergedArea: 0, totalArea, fullySubmerged: false, dry: true };
  }
  // A small tolerance, because heights are differences of floating-point
  // numbers: a hole whose top sits exactly at the liquid surface computes as
  // 0.19999999999999996 against a diameter of 0.2 and would otherwise be
  // reported as partially submerged forever.
  if (submergedHeight >= hole.diameter - 1e-9) {
    return { submergedArea: totalArea, totalArea, fullySubmerged: true, dry: false };
  }

  // Circular segment of height `submergedHeight`
  const h = submergedHeight;
  const segmentArea =
    radius * radius * Math.acos((radius - h) / radius) -
    (radius - h) * Math.sqrt(2 * radius * h - h * h);

  return { submergedArea: segmentArea, totalArea, fullySubmerged: false, dry: false };
}

/**
 * Height of the liquid column above the bottom of the hole — the head that
 * drives the flow.
 *
 * Returns zero when the hole is above the liquid, rather than a negative
 * number, so callers cannot accidentally compute a negative driving pressure.
 */
export function headAboveHole(liquidDepth, hole) {
  return Math.max(0, liquidDepth - hole.heightAboveBottom);
}
