'use strict';

const CLEAR_AFTER_MS = 60 * 1000;

/**
 * Poor reception: on once a streaming tuner's signal quality has stayed below
 * `threshold` for `minutes`, off once no streaming tuner has been below it for a minute.
 * Idle tuners have no signal reading, so they neither raise nor hold the alert.
 */
class ReceptionWatch {
  constructor({ threshold = 60, minutes = 3 } = {}) {
    this.threshold = Number(threshold) || 60;
    this.holdMs = Math.max(0, Number(minutes ?? 3)) * 60 * 1000;
    this.lowSince = new Map(); // tuner index → time it went low
    this.active = false;
    this.since = null;
    this.okSince = null;
    this.detail = null;
  }

  /** Returns 'started' or 'ended' when the alert changes, else null. */
  update(tuners, online, now = Date.now()) {
    let worst = null;
    for (const t of online ? tuners : []) {
      const q = t.signalQuality;
      if (t.inUse && q !== undefined && q < this.threshold) {
        if (!this.lowSince.has(t.index)) this.lowSince.set(t.index, now);
        if (!worst || q < worst.signalQuality) worst = t;
      } else {
        this.lowSince.delete(t.index);
      }
    }
    if (!online) this.lowSince.clear();

    const longest = Math.min(...[...this.lowSince.values()], Infinity);
    const low = this.lowSince.size > 0;
    if (worst) {
      this.detail = {
        tuner: worst.index,
        signalQuality: worst.signalQuality,
        signalStrength: worst.signalStrength,
        channelNumber: worst.channelNumber,
        channelName: worst.channelName,
      };
    }

    if (!this.active && low && now - longest >= this.holdMs) {
      this.active = true;
      this.since = now;
      this.okSince = null;
      return 'started';
    }
    if (this.active) {
      if (low) this.okSince = null;
      else if (!this.okSince) this.okSince = now;
      if (this.okSince && now - this.okSince >= CLEAR_AFTER_MS) {
        this.active = false;
        this.since = null;
        this.okSince = null;
        return 'ended';
      }
    }
    return null;
  }

  state() {
    return {
      active: this.active,
      since: this.since,
      threshold: this.threshold,
      minutes: this.holdMs / 60000,
      detail: this.active ? this.detail : null,
    };
  }
}

module.exports = { ReceptionWatch };
