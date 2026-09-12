// One explicit switch between the two ways Slicely runs: "hosted" (npm run
// serve / Docker — a shared server reached by any internet visitor) and
// "desktop" (the Electron app, on one user's own machine). Hosted is the
// default so a deploy that forgets to set anything gets the SAFER posture
// (LAN discovery off, `__Host-` session cookie, etc.) rather than silently
// running open. Desktop must be opted into explicitly.
//
// Read `process.env.SLICELY_MODE` fresh on every call — no caching — so
// tests can flip it mid-run and so Electron's early
// `process.env.SLICELY_MODE = "desktop"` (set before any module that reads
// it is imported) always takes effect.
export type SlicelyMode = "hosted" | "desktop";

export function getMode(): SlicelyMode {
  const raw = process.env.SLICELY_MODE;
  if (raw === undefined || raw === "") return "hosted";
  if (raw === "hosted" || raw === "desktop") return raw;
  throw new Error(
    `SLICELY_MODE must be "hosted" or "desktop" (or unset, which defaults to "hosted") — got ${JSON.stringify(raw)}`,
  );
}

export function isHosted(): boolean {
  return getMode() === "hosted";
}

export function isDesktop(): boolean {
  return getMode() === "desktop";
}
