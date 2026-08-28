// LAN printer discovery. Three layered strategies, cheapest/most-reliable
// first:
//
//   1. mDNS (bonjour-service) for the two transports that actually advertise
//      themselves: `_octoprint._tcp` and `_moonraker._tcp`. Also browses the
//      generic `_printer._tcp` and `_http._tcp` service types, since
//      PrusaLink and Bambu's LAN web UI are known to answer plain HTTP mDNS
//      without a vendor-specific service type — those are only trusted when
//      the advertised name/TXT record actually mentions Prusa or Bambu, to
//      avoid mistaking someone's random home-network HTTP server for a
//      printer.
//   2. Bambu's SSDP-style broadcast on UDP 2021 — Bambu Lab doesn't publish
//      this protocol; the header names read here (DevName.bambu.com,
//      DevModel.bambu.com) come from community LAN-discovery reimplementa-
//      tions, not an official spec. Best-effort and wrapped in try/catch.
//   3. A bounded concurrent TCP sweep of the local /24 as a last resort, for
//      networks that filter multicast (common on guest Wi-Fi / VLANs). Only
//      runs when steps 1–2 found nothing, since flooding the LAN with ~760
//      connection attempts (254 hosts × 3 ports) isn't something to do
//      automatically alongside a discovery method that usually just works.
//
// The whole thing always resolves within `timeoutMs` and never throws —
// discovery is a "nice to have" UI feature, not something that should be
// able to crash the app if bonjour-service or a raw socket misbehaves.
import { createSocket } from "node:dgram";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import Bonjour, { type Service } from "bonjour-service";
import type { DiscoveredPrinter, PrinterTransport } from "../../shared/printers";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const BAMBU_LAN_PORT = 8883;
const BAMBU_SSDP_PORT = 2021;
const SWEEP_PORTS = [80, 5000, 7125];
const SWEEP_CONCURRENCY = 32;
const SWEEP_CONNECT_TIMEOUT_MS = 400;
const SWEEP_FINGERPRINT_TIMEOUT_MS = 1500;

/** Run every discovery strategy and return whatever was found, deduped by
 *  host:port. Never throws; always settles by `timeoutMs`. */
export async function discoverPrinters(timeoutMs: number = DEFAULT_DISCOVERY_TIMEOUT_MS): Promise<DiscoveredPrinter[]> {
  const found = new Map<string, DiscoveredPrinter>();
  try {
    await Promise.race([
      runDiscovery(timeoutMs, found),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    /* best-effort: return whatever was found before anything went wrong */
  }
  return [...found.values()];
}

async function runDiscovery(timeoutMs: number, found: Map<string, DiscoveredPrinter>): Promise<void> {
  await Promise.allSettled([
    mdnsDiscover(timeoutMs, found),
    bambuSsdpDiscover(Math.min(timeoutMs, 3000), found),
  ]);

  if (found.size === 0) {
    // Leave a little slack under the outer race so the sweep's own internal
    // bookkeeping doesn't blow past the caller's deadline.
    const remaining = timeoutMs - 500;
    if (remaining > 500) {
      await tcpSweepDiscover(remaining, found).catch(() => {});
    }
  }
}

// ── mDNS ─────────────────────────────────────────────────────────────────────

function mdnsDiscover(timeoutMs: number, found: Map<string, DiscoveredPrinter>): Promise<void> {
  return new Promise((resolve) => {
    let bonjour: Bonjour | undefined;
    try {
      bonjour = new Bonjour();
    } catch {
      resolve();
      return;
    }

    const browsers = [
      bonjour.find({ type: "octoprint" }, (service) => addVendorService(service, "octoprint", found)),
      bonjour.find({ type: "moonraker" }, (service) => addVendorService(service, "moonraker", found)),
      // Generic types — only trusted after a name/TXT hint (see classifyGenericService).
      bonjour.find({ type: "printer" }, (service) => addGenericService(service, found)),
      bonjour.find({ type: "http" }, (service) => addGenericService(service, found)),
    ];

    setTimeout(() => {
      for (const b of browsers) {
        try {
          b.stop();
        } catch {
          /* already stopped */
        }
      }
      try {
        bonjour?.destroy();
      } catch {
        /* already destroyed */
      }
      resolve();
    }, timeoutMs);
  });
}

function firstAddress(service: Service): string | undefined {
  const addrs = service.addresses ?? [];
  // Prefer a plain IPv4 dotted-quad — PrinterConnection.host has no address-
  // family concept elsewhere in Slicely, so IPv4 keeps things simple.
  return addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? addrs[0] ?? service.host;
}

function addVendorService(
  service: Service,
  transport: PrinterTransport,
  found: Map<string, DiscoveredPrinter>,
): void {
  const host = firstAddress(service);
  if (!host || !service.port) return;
  const key = `${host}:${service.port}`;
  if (found.has(key)) return;
  found.set(key, {
    transport,
    host,
    port: service.port,
    label: service.name || host,
    needs: transport === "octoprint" ? "Needs an API key." : undefined,
  });
}

/** Classify a generic `_printer._tcp` / `_http._tcp` mDNS service by name/TXT
 *  hints. Returns undefined for anything that doesn't look like Prusa or
 *  Bambu — a bare "_http._tcp" match is too weak to trust on its own (it
 *  matches every web server on the LAN). Exported for direct unit testing. */
export function classifyGenericService(name: string, txt: Record<string, unknown>): PrinterTransport | undefined {
  const hint = `${name} ${JSON.stringify(txt)}`.toLowerCase();
  if (hint.includes("prusa")) return "prusalink";
  if (hint.includes("bambu") || hint.includes("bbl")) return "bambu-lan";
  return undefined;
}

function addGenericService(service: Service, found: Map<string, DiscoveredPrinter>): void {
  const host = firstAddress(service);
  if (!host || !service.port) return;
  const transport = classifyGenericService(service.name || "", (service.txt as Record<string, unknown>) ?? {});
  if (!transport) return;
  const key = `${host}:${service.port}`;
  if (found.has(key)) return;
  found.set(key, {
    transport,
    host,
    port: service.port,
    label: service.name || host,
    needs: transport === "bambu-lan" ? "Needs the LAN access code from the printer's screen." : "Needs an API key.",
  });
}

// ── Bambu SSDP (UDP 2021) ────────────────────────────────────────────────────

/** Extract one header's value from a raw NOTIFY/HTTP-style datagram. */
export function ssdpHeader(raw: string, header: string): string | undefined {
  const re = new RegExp(`^${header}:\\s*(.+)$`, "im");
  return re.exec(raw)?.[1]?.trim();
}

function bambuSsdpDiscover(timeoutMs: number, found: Map<string, DiscoveredPrinter>): Promise<void> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof createSocket> | undefined;
    try {
      socket = createSocket({ type: "udp4", reuseAddr: true });
    } catch {
      resolve();
      return;
    }

    const finish = () => {
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      resolve();
    };

    socket.on("error", finish);
    socket.on("message", (msg, rinfo) => {
      // Bambu printers broadcast periodic NOTIFY-style datagrams on UDP 2021
      // carrying vendor headers. Reverse-engineered from community tooling,
      // not from Bambu's own documentation (they don't publish this).
      const text = msg.toString("utf8");
      if (!/bambu\.com/i.test(text)) return;
      const name = ssdpHeader(text, "DevName.bambu.com") || ssdpHeader(text, "USN") || rinfo.address;
      const model = ssdpHeader(text, "DevModel.bambu.com");
      const key = `${rinfo.address}:${BAMBU_LAN_PORT}`;
      if (found.has(key)) return;
      found.set(key, {
        transport: "bambu-lan",
        host: rinfo.address,
        port: BAMBU_LAN_PORT,
        label: name || `Bambu printer (${rinfo.address})`,
        model,
        needs: "Needs the LAN access code from the printer's screen.",
      });
    });

    try {
      socket.bind(BAMBU_SSDP_PORT, () => {
        try {
          socket?.setBroadcast(true);
        } catch {
          /* not fatal — we can still receive without it */
        }
      });
    } catch {
      finish();
      return;
    }

    setTimeout(finish, timeoutMs);
  });
}

// ── TCP sweep fallback ───────────────────────────────────────────────────────

/** Every plain-/24 IPv4 host on this machine's LAN interfaces, minus our own
 *  address. Only handles the common /24 case — anything else and a guessed
 *  scan range is more likely to be wrong than useful. */
function localSubnetHosts(): string[] {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (iface.netmask !== "255.255.255.0") continue;
      const parts = iface.address.split(".").map(Number);
      const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
      const hosts: string[] = [];
      for (let i = 1; i <= 254; i++) {
        if (i === parts[3]) continue; // skip our own address
        hosts.push(`${base}.${i}`);
      }
      return hosts;
    }
  }
  return [];
}

function probeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function tryJson(url: string, timeoutMs: number): Promise<unknown> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Probe an open host:port with a couple of unauthenticated HTTP requests to
 *  tell OctoPrint, Moonraker, and PrusaLink apart. Best-effort: any parse
 *  failure means "not recognized" rather than a thrown error. */
async function fingerprintHttp(host: string, port: number, timeoutMs: number): Promise<DiscoveredPrinter | undefined> {
  const base = `http://${host}:${port}`;

  // Moonraker: GET /printer/info returns {result:{...}}, unauthenticated.
  const moonraker = await tryJson(`${base}/printer/info`, timeoutMs);
  if (moonraker && typeof moonraker === "object" && "result" in (moonraker as object)) {
    return { transport: "moonraker", host, port, label: `Moonraker (${host})` };
  }

  // OctoPrint and PrusaLink both answer GET /api/version. There's no reliable
  // field to tell them apart from this endpoint alone; a hostname/text
  // mention of "prusa" is the only signal available without credentials, so
  // this defaults to OctoPrint (the more common self-hosted case) otherwise
  // and lets the user correct the transport if it guessed wrong.
  const version = await tryJson(`${base}/api/version`, timeoutMs);
  if (version && typeof version === "object") {
    const v = version as { text?: string; hostname?: string };
    const looksPrusa = /prusa/i.test(v.text || "") || /prusa/i.test(v.hostname || "");
    return {
      transport: looksPrusa ? "prusalink" : "octoprint",
      host,
      port,
      label: v.hostname || `${looksPrusa ? "PrusaLink" : "OctoPrint"} (${host})`,
      needs: "Needs an API key.",
    };
  }

  return undefined;
}

async function tcpSweepDiscover(budgetMs: number, found: Map<string, DiscoveredPrinter>): Promise<void> {
  const hosts = localSubnetHosts();
  if (hosts.length === 0) return;

  const deadline = Date.now() + budgetMs;
  const targets: Array<{ host: string; port: number }> = [];
  for (const host of hosts) for (const port of SWEEP_PORTS) targets.push({ host, port });

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < targets.length && Date.now() < deadline) {
      const target = targets[cursor++];
      const open = await probeTcp(target.host, target.port, SWEEP_CONNECT_TIMEOUT_MS);
      if (!open) continue;
      const key = `${target.host}:${target.port}`;
      if (found.has(key)) continue;
      const fp = await fingerprintHttp(target.host, target.port, SWEEP_FINGERPRINT_TIMEOUT_MS).catch(() => undefined);
      if (fp) found.set(key, fp);
    }
  }

  const workerCount = Math.min(SWEEP_CONCURRENCY, targets.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.race([Promise.all(workers), new Promise<void>((resolve) => setTimeout(resolve, budgetMs))]);
}
