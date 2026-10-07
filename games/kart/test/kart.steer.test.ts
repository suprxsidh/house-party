import { test } from 'node:test';
import assert from 'node:assert/strict';
import { steerFromTilt } from '../phone/steer.ts';

// Portrait is a sloppy way to steer (a wheel turn is roll about the view axis, which Euler angles
// blur near beta 90), so these use a tilted-back phone. Landscape is the real posture.
// Steering is not negated: turning the phone clockwise like a wheel steers right.
test('portrait: right side down steers right', () => {
  assert.ok(steerFromTilt(50, 40, 0) > 0.3);
  assert.ok(steerFromTilt(50, -40, 0) < -0.3);
  assert.equal(steerFromTilt(50, 1, 0), 0, 'dead zone');
  assert.equal(steerFromTilt(50, 85, 0), 1, 'clamps at full lock');
});

test('landscape top-left (angle 90): clockwise wheel turn steers right', () => {
  // upright landscape: beta 0, gamma -90. Turning clockwise raises the top edge: beta grows.
  assert.ok(steerFromTilt(20, -90, 90) > 0.3);
  assert.ok(steerFromTilt(-20, -90, 90) < -0.3);
});

test('landscape top-right (angle 270): clockwise turn steers right', () => {
  assert.ok(steerFromTilt(-20, 90, 270) > 0.3);
  assert.ok(steerFromTilt(20, 90, 270) < -0.3);
});
