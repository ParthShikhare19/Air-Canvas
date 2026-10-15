/* One Euro filter: smooths a jittery signal without making it feel laggy.
 *
 * A hand held in mid-air shakes by a few pixels. A normal average would remove
 * the shake but also make fast strokes lag behind the finger. The One Euro
 * filter changes its strength with speed:
 *   slow movement -> strong smoothing (kills the tremor)
 *   fast movement -> weak smoothing   (follows the finger closely)
 * Casiez, Roussel, Vogel: "1 Euro Filter", CHI 2012.
 */
(function (root) {
  "use strict";

  function createOneEuro(minCutoff, beta, dCutoff) {
    let xPrev = null, dxPrev = 0, tPrev = null;
    const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff) / dt);

    return {
      reset() { xPrev = null; dxPrev = 0; tPrev = null; },
      /** x: new value, t: timestamp in milliseconds */
      filter(x, t) {
        if (xPrev === null) { xPrev = x; tPrev = t; return x; }
        const dt = Math.max((t - tPrev) / 1000, 1e-3);
        const speed = (x - xPrev) / dt;
        const aSpeed = alpha(dCutoff, dt);
        const speedHat = aSpeed * speed + (1 - aSpeed) * dxPrev;
        const cutoff = minCutoff + beta * Math.abs(speedHat);
        const a = alpha(cutoff, dt);
        const xHat = a * x + (1 - a) * xPrev;
        xPrev = xHat; dxPrev = speedHat; tPrev = t;
        return xHat;
      },
    };
  }

  if (typeof module !== "undefined" && module.exports) module.exports = createOneEuro;
  else root.createOneEuro = createOneEuro;
})(typeof window !== "undefined" ? window : globalThis);
