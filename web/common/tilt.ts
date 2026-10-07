export type TiltResult = 'granted' | 'denied' | 'unsupported';
export interface Tilt { beta: number; gamma: number; alpha: number }

let latest: Tilt = { beta: 0, gamma: 0, alpha: 0 };
let listening = false;
const subs = new Set<(t: Tilt) => void>();

/** iOS needs this called from a tap. Android and desktop just work. */
export async function enableTilt(): Promise<TiltResult> {
  const D = (window as any).DeviceOrientationEvent;
  if (!D) return 'unsupported';
  if (typeof D.requestPermission === 'function') {
    try {
      const r = await D.requestPermission();
      if (r !== 'granted') return 'denied';
    } catch {
      return 'denied';
    }
  }
  if (!listening) {
    listening = true;
    window.addEventListener('deviceorientation', (e) => {
      latest = { beta: e.beta ?? 0, gamma: e.gamma ?? 0, alpha: e.alpha ?? 0 };
      subs.forEach((f) => f(latest));
    });
  }
  return 'granted';
}
export const getTilt = () => latest;
export function onTilt(f: (t: Tilt) => void) {
  subs.add(f);
  return () => void subs.delete(f);
}
