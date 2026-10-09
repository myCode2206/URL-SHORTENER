// What the redirect path knows about one click. Phase 9 adds the hashed IP,
// country and parsed device, browser and OS.
export interface ClickEvent {
  urlId: bigint;
  clickedAt: Date;
  userAgent: string | null;
  referrer: string | null;
}

// Used by the redirect path. `record` must return immediately and never throw:
// analytics can lag, lose data or fail completely, but a redirect must never
// wait for it or fail because of it.
export interface ClickRecorder {
  record(event: ClickEvent): void;
}
