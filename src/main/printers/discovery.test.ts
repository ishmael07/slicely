// discoverPrinters() itself opens real mDNS/UDP/TCP sockets by design (see
// discovery.ts's file-header comment) and is deliberately NOT invoked here —
// that would violate "no live network" for this test suite and could hang or
// misbehave in a sandboxed/CI environment (multicast often isn't routed,
// and macOS may prompt for local-network permission). These tests instead
// cover the two pure classification helpers the network code feeds into,
// which is where the actual "is this a printer" logic (and its bugs) lives.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyGenericService, ssdpHeader } from "./discovery";

test("classifyGenericService recognizes Prusa and Bambu hints, rejects everything else", () => {
  assert.equal(classifyGenericService("PrusaLink (MK4)", {}), "prusalink");
  assert.equal(classifyGenericService("my-printer", { vendor: "Prusa Research" }), "prusalink");
  assert.equal(classifyGenericService("Bambu Lab X1 Carbon", {}), "bambu-lan");
  assert.equal(classifyGenericService("BBL-X1C-01", {}), "bambu-lan");
  assert.equal(classifyGenericService("Some Random HP Printer", {}), undefined);
  assert.equal(classifyGenericService("synology-nas", { model: "DS920+" }), undefined);
});

test("classifyGenericService is case-insensitive and checks TXT record values too", () => {
  assert.equal(classifyGenericService("printer1", { model: "PRUSA-MK4S" }), "prusalink");
  assert.equal(classifyGenericService("PRINTER-UPPERCASE", {}), undefined);
});

test("ssdpHeader extracts a header's value from a raw NOTIFY-style datagram", () => {
  const raw = [
    "NOTIFY * HTTP/1.1",
    "HOST: 239.255.255.250:2021",
    "Server: Buildroot/2020.02.6 UPnP/1.0",
    "DevName.bambu.com: Bambu Lab X1 Carbon",
    "DevModel.bambu.com: BL-P001",
    "",
  ].join("\r\n");

  assert.equal(ssdpHeader(raw, "DevName.bambu.com"), "Bambu Lab X1 Carbon");
  assert.equal(ssdpHeader(raw, "DevModel.bambu.com"), "BL-P001");
  assert.equal(ssdpHeader(raw, "NoSuchHeader"), undefined);
});
