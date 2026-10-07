// Turn phone orientation into a steering value. Pure, so a test can check the signs.
// Result: -1 (full left) .. +1 (full right). Not negated: tilt like a steering wheel,
// clockwise = right, in portrait or landscape.

/** Tilt at which steering is full lock, degrees. */
export const FULL_LOCK_DEG = 32;
const DEAD = 0.05;

/**
 * beta/gamma are the DeviceOrientation angles in degrees. `screenAngle` is
 * screen.orientation.angle (0 portrait, 90 landscape with the top to the left,
 * 270 landscape with the top to the right, 180 upside down).
 *
 * Gravity ("up") in device axes is (-sin g cos b, sin b, cos g cos b). We rotate it to
 * screen axes and read its sideways part: when the player turns the phone clockwise,
 * "up" leans to the screen's left, so steer = -x_screen.
 */
export function steerFromTilt(beta: number, gamma: number, screenAngle: number): number {
  const b = (beta * Math.PI) / 180;
  const g = (gamma * Math.PI) / 180;
  const xd = -Math.sin(g) * Math.cos(b);
  const yd = Math.sin(b);
  const a = ((Math.round(screenAngle / 90) % 4) + 4) % 4;
  const xs = a === 0 ? xd : a === 1 ? -yd : a === 2 ? -xd : yd;
  const raw = -xs / Math.sin((FULL_LOCK_DEG * Math.PI) / 180);
  const v = Math.max(-1, Math.min(1, raw));
  if (Math.abs(v) < DEAD) return 0;
  // gentle curve: fine control near the centre, full lock at the edge
  return Math.sign(v) * Math.pow(Math.abs(v), 1.25);
}

export function currentScreenAngle(): number {
  const so = (screen as Screen & { orientation?: { angle: number } }).orientation;
  if (so && typeof so.angle === 'number') return so.angle;
  const w = (window as unknown as { orientation?: number }).orientation;
  return typeof w === 'number' ? w : 0;
}
