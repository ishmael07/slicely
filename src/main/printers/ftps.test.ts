// Tests for the hand-rolled implicit-FTPS client.
//
// The reply parsing is tested directly. The upload is tested against a real
// TLS server that speaks just enough FTP to accept a STOR, so the command
// sequence, the passive-mode handshake, and the data connection are all
// exercised for real rather than mocked away — this is a protocol written from
// the RFC, so proving it on the wire is the point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:tls";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { parsePasv, parseEpsv, ftpsUpload } from "./ftps";

test("parsePasv reads the host and the big-endian port pair", () => {
  const r = parsePasv("227 Entering Passive Mode (192,168,1,50,234,12).");
  assert.deepEqual(r, { host: "192.168.1.50", port: 234 * 256 + 12 });
});

test("parsePasv rejects out-of-range octets rather than dialling nonsense", () => {
  assert.equal(parsePasv("227 Entering Passive Mode (999,1,1,1,1,1)."), undefined);
  assert.equal(parsePasv("227 no numbers here"), undefined);
});

test("parseEpsv reads the port from an extended passive reply", () => {
  assert.equal(parseEpsv("229 Entering Extended Passive Mode (|||50123|)"), 50123);
  assert.equal(parseEpsv("229 malformed"), undefined);
  assert.equal(parseEpsv("229 (|||0|)"), undefined);
});

// ── A minimal FTPS server, just enough to accept one upload ─────────────────

/** Self-signed cert so the client's TLS handshake has something to talk to. */
function selfSigned(): { key: string; cert: string } {
  return { key: TEST_KEY, cert: TEST_CERT };
}

interface FakeServer {
  port: number;
  received: () => Buffer | undefined;
  commands: string[];
  close: () => Promise<void>;
}

async function startFakeFtps(): Promise<FakeServer> {
  const { key, cert } = selfSigned();
  const commands: string[] = [];
  let received: Buffer | undefined;
  let dataServer: Server | undefined;

  const server = createServer({ key, cert }, (socket) => {
    socket.setEncoding("utf8");
    socket.write("220 Fake Bambu FTPS ready\r\n");
    socket.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
        commands.push(line);
        const [verb, ...rest] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "USER":
            socket.write("331 Need password\r\n");
            break;
          case "PASS":
            socket.write(rest[0] === "correct-code" ? "230 Logged in\r\n" : "530 Login incorrect\r\n");
            break;
          case "TYPE":
          case "PBSZ":
          case "PROT":
            socket.write("200 OK\r\n");
            break;
          case "EPSV":
            // Force the PASV fallback path, which is the one Bambu uses.
            socket.write("502 Not implemented\r\n");
            break;
          case "PASV": {
            dataServer = createServer({ key, cert }, (dataSock) => {
              const chunks: Buffer[] = [];
              dataSock.on("data", (d: Buffer) => chunks.push(Buffer.from(d)));
              dataSock.on("end", () => {
                received = Buffer.concat(chunks);
                socket.write("226 Transfer complete\r\n");
              });
              // A reset during teardown is normal here and must not surface as
              // an uncaught exception.
              dataSock.on("error", () => undefined);
            });
            dataServer.listen(0, "127.0.0.1", () => {
              const p = (dataServer!.address() as AddressInfo).port;
              socket.write(`227 Entering Passive Mode (127,0,0,1,${Math.floor(p / 256)},${p % 256}).\r\n`);
            });
            break;
          }
          case "STOR":
            socket.write("150 Opening data connection\r\n");
            break;
          case "QUIT":
            socket.write("221 Bye\r\n");
            socket.end();
            break;
          default:
            socket.write("500 Unknown\r\n");
        }
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as AddressInfo).port,
    received: () => received,
    commands,
    close: () =>
      new Promise((r) => {
        dataServer?.close();
        server.close(() => r());
      }),
  };
}

test("ftpsUpload transfers the file and issues the FTP sequence in order", async () => {
  const srv = await startFakeFtps();
  const dir = mkdtempSync(join(tmpdir(), "slicely-ftps-"));
  const local = join(dir, "plate_1.gcode");
  const body = "; a sliced plate\nG1 X10 Y10\n".repeat(200);
  writeFileSync(local, body);

  try {
    const res = await ftpsUpload({
      localPath: local,
      host: "127.0.0.1",
      port: srv.port,
      user: "bblp",
      password: "correct-code",
      timeoutMs: 10_000,
    });

    assert.equal(res.remoteName, "plate_1.gcode");
    assert.equal(res.bytes, Buffer.byteLength(body));
    assert.equal(
      srv.received()?.toString(),
      body,
      "the bytes the server received must match the file exactly",
    );

    const verbs = srv.commands.map((c) => c.split(" ")[0].toUpperCase());
    // Binary mode and data-channel protection must precede the transfer, and
    // PBSZ must precede PROT (RFC 4217).
    assert.ok(verbs.indexOf("TYPE") < verbs.indexOf("STOR"));
    assert.ok(verbs.indexOf("PBSZ") < verbs.indexOf("PROT"));
    assert.ok(verbs.indexOf("PROT") < verbs.indexOf("STOR"));
    assert.ok(verbs.includes("PASV"), "must fall back to PASV when EPSV is refused");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

test("a wrong access code fails with a message naming the access code", async () => {
  const srv = await startFakeFtps();
  const dir = mkdtempSync(join(tmpdir(), "slicely-ftps-"));
  const local = join(dir, "x.gcode");
  writeFileSync(local, "G1\n");
  try {
    await assert.rejects(
      () =>
        ftpsUpload({
          localPath: local,
          host: "127.0.0.1",
          port: srv.port,
          user: "bblp",
          password: "wrong",
          timeoutMs: 10_000,
        }),
      /access code/i,
      "the error must point at the access code, not a bare FTP number",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});

// A throwaway self-signed pair, inlined so the test is self-contained and
// survives compilation to dist/ (nothing copies fixture files there). It is
// used only by the loopback server above and is not a secret.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC3lhxZTYJDJv0T
YLE0foy45xN1No8LtHCdpvZ73j9JwNYBOqYBRLwKnQFfE7XiBpxnFVoJQ0FCZ0L+
qch0lUsEaVj8KVL/eYI8DwhjyiXxN8QeMbGu0BsdKyew9ckOiccYAti7Kh35pWgJ
rKeCq+NQk0BVcyxw+pggPbdzV59v82wKxEuVx5AGmctdepm1T44BFUKe048SL4EG
T/lmVlhrnEgrmmnvBaCz9jo30yJyzMH+9yWf4OKsILdsi4aNBbqQ0iMKs9u74pCJ
aA8bFATnWsPyowXTDZiRqvpaFSOO06oVxJkLFwVvC0m38ZqmLOGuZV6KvfD0K8L9
wHUfjVFRAgMBAAECggEAVu585Aigyx2WLuvVXW8jQZciDpnUKI272dsq0kLOIyVt
8M0NuIIMrNXlxVi3Ap1wyBtDNCmlqETvY1mQMyxShndADL+grpqiAcB4j5A0YUGv
20Bay9V9UVWTCOeJ2hmBriwC5rWt1f3uAs6/z0+HZysjBpNwEtuG15WB3ds7Ay4p
RaPGhLv1bCmaRV0GMSKNqMHeFWe6LEgwjliXEnibdLk4+wWgghp9UC334XBbzyyg
uSao5pYr3jREEJDsk/NN+QcTdapSX1IhfyVQmCct+2j+9JbsfRitu5lwWW9xxpyc
d8UASsd08zwJGfiCLzsbVkStiJAvUehlLF0j6VC0FQKBgQD0pbZnnUnwQstY4/bw
CDW6aE7LIaW0Z3ZwKhGtax/Lr+gTeTItlX6VLm5hSd4Ogj9cjPdph0fhBZoETxuH
GH4igqwVZHEc9TbG0H/ViaPxoHeQ3oC5vhF6I4jBRfsrfw9Odem7M9HO3Z+twS8a
opfn5eQ+Z+AoBmeDcz1nCbm1swKBgQDAGwZZb65Al4Yp0tGQf4A+O5INV9xlXskH
kTTn2dsKgd7wh/OLlhgBl5o+JzJ3jbjpfk/eK/28FMj0qCyM8I8AoPG5XmDWmloM
HlVoAfnz5ErQ1UaCyoJJX6m7/uTsoshVWhIFUMawGVompprNoBn3SfGbLBmAnWNP
aifZQudi6wKBgQDlNTCNKR8x29KaiJI91uNHrxxLUk3mlJyxf6iqOlhCxJ8BR6ZM
cOh0qli+C6/hFgR5GJVgqF8eotnmuZsH2lmqyZSiQkV7pP5aDNQH43nXEsmSz/P4
kevb69jfg0pMOTHFB9IhEu66CoflCb6xDK6XlJpgIYAw37cxv9FCbSkx4wKBgGXJ
q/qVj0nQP5lHiBy9QhE3dTK2vCPGLlRhHxw+Na6Ck8L09hmfBMdLMcH++OGZ6UFm
2SDKRF500Om5dimTiOH3ZT0oAb2T+WR0aiJ68ZrF+tJeP0cr0A7ark/bRicQNX/s
AqJoY26JcFgMbPfI/hkmR+tFWZnpSuaYQ9b9eSbTAoGAEZB0Q9FgfcJVDEMb/FP9
dldJ/8OvSrtOSFlvrCy8wtyOGJFmbTdiVHmUCyEjge5MSRW14X126aiqAeckgdmR
3eYF9PXsb5bYtEiRJCyPmXj6qABArSDjRjHGX4A0zlyTBCIEhGudGg6tgbgU0+P0
qw49xwZcnh92DSaRb3s7NXU=
-----END PRIVATE KEY-----`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIICpjCCAY4CCQCbCveQ35GTFDANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwIBcNMjYwODI4MjAyOTA1WhgPMjEyNjA4MDQyMDI5MDVaMBQxEjAQ
BgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
ALeWHFlNgkMm/RNgsTR+jLjnE3U2jwu0cJ2m9nveP0nA1gE6pgFEvAqdAV8TteIG
nGcVWglDQUJnQv6pyHSVSwRpWPwpUv95gjwPCGPKJfE3xB4xsa7QGx0rJ7D1yQ6J
xxgC2LsqHfmlaAmsp4Kr41CTQFVzLHD6mCA9t3NXn2/zbArES5XHkAaZy116mbVP
jgEVQp7TjxIvgQZP+WZWWGucSCuaae8FoLP2OjfTInLMwf73JZ/g4qwgt2yLho0F
upDSIwqz27vikIloDxsUBOdaw/KjBdMNmJGq+loVI47TqhXEmQsXBW8LSbfxmqYs
4a5lXoq98PQrwv3AdR+NUVECAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAHGGZVTB3
6j6zacynKqlJLMusdTIjgbd+zmgOVS7zeCJEpYwSK6L4n2m3E4K8xv4kOvTMJ73F
I6sligzSPnmzEuNpIqZG1zCnU8b6cHtIHzyptORZn/KSYE9ZenOLcO2XiwVPSwYj
v1/x/FVw5VKIaNxdr6IvnvTy8YGXbobtUcaK90lbKs93qM1ZLsCqP6/AEp01j0tu
gTbGdS4qkpG4x5MCLNeUjb8hGVkrBh5WwEQJkboAgcLybGa8sT74s1XSzbIoq+Pw
puWwdTRugY0q1hFxPmNI1oiMIBJfIVvUQT7ANYbvFQE+wYxudcLMk9/AlbHg37ir
aUC10/sdxfRQvA==
-----END CERTIFICATE-----`;
