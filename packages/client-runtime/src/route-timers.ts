import { ROUTE_LIMITS as limits } from "@kraka/protocol";
import type { MonotonicClock } from "./index";

export interface RouteClock extends MonotonicClock {
  utcMilliseconds(): number;
  after(milliseconds: number, callback: () => void): () => void;
}

export class Deadline {
  private disarm?: () => void;
  private expires = Infinity;
  constructor(private readonly clock: RouteClock) {}
  set(ms: number, expire: () => void) {
    this.clear();
    this.expires = this.clock.nowMilliseconds() + ms;
    this.disarm = this.clock.after(ms, expire);
  }
  expired() {
    return this.clock.nowMilliseconds() >= this.expires;
  }
  clear() {
    this.disarm?.();
    this.expires = Infinity;
  }
}

export function retryDelay(failures: number, sample: number): number {
  const cap =
    failures === 0
      ? limits.firstReconnectMaximumMs
      : Math.min(
          limits.reconnectMaximumCapMs,
          limits.reconnectInitialCapMs * limits.reconnectCapMultiplier ** (failures - 1),
        );
  const minimum =
    failures === 0 ? limits.firstReconnectMinimumMs : cap * limits.reconnectMinimumFraction;
  return minimum + Math.floor(sample * (cap - minimum + 1));
}

export function monitorRoute(clock: RouteClock, probe: (serial: number) => void, lost: () => void) {
  let serial = 0;
  let acknowledged = 0;
  let foregroundSerial: number | null = null;
  const expiry = new Deadline(clock);
  const fast = new Deadline(clock);
  const tick = new Deadline(clock);
  const ping = () => {
    tick.set(limits.probeIntervalMs, ping);
    probe(++serial);
  };
  expiry.set(limits.noAnswerTimeoutMs, lost);
  tick.set(limits.probeIntervalMs, ping);
  return {
    foreground() {
      foregroundSerial = ++serial;
      fast.set(limits.foregroundProbeTimeoutMs, lost);
      probe(serial);
    },
    echo(reply: number) {
      if (expiry.expired() || fast.expired()) return lost();
      if (reply <= acknowledged || reply > serial) return;
      acknowledged = reply;
      expiry.set(limits.noAnswerTimeoutMs, lost);
      if (foregroundSerial !== null && reply >= foregroundSerial) {
        fast.clear();
        foregroundSerial = null;
      }
    },
    close() {
      tick.clear();
      expiry.clear();
      fast.clear();
    },
  };
}
