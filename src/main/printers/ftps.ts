// ─────────────────────────────────────────────────────────────────────────────
// A minimal implicit-FTPS client, written against node:tls because nothing in
// this project's dependency set speaks FTP.
//
// This exists for one reason: Bambu Lab printers accept files over FTPS on port
// 990 and nothing else on the LAN. Without it Slicely can read a Bambu's status
// and control a running print but cannot actually send it a job, which is most
// of the point.
//
// "Implicit" FTPS means TLS is established before the first byte of FTP —
// unlike explicit FTPS (AUTH TLS on port 21). Bambu uses implicit.
//
// Deliberately narrow: it uploads one file and does nothing else. No LIST, no
// directory traversal, no resume. Anything more belongs in a real FTP library.
//
// Protocol references: RFC 959 (FTP), RFC 4217 (FTP over TLS).
// ─────────────────────────────────────────────────────────────────────────────
import { connect as tlsConnect, type TLSSocket, type ConnectionOptions } from "node:tls";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

/** Bambu's FTPS port. Implicit TLS, so there is no AUTH TLS handshake. */
export const BAMBU_FTPS_PORT = 990;

export interface FtpsOptions {
  /** Absolute path of the file to upload. */
  localPath: string;
  host: string;
  port?: number;
  user: string;
  password: string;
  /** Remote filename. Defaults to the local basename. */
  remoteName?: string;
  /** Remote directory. Bambu expects uploads in the root, so this defaults to
   *  "" (no CWD). Set e.g. "cache" if a model needs it. */
  remoteDir?: string;
  /** Per-operation timeout in ms. */
  timeoutMs?: number;
}

/** One parsed FTP reply: a 3-digit code and its text. */
export interface FtpReply {
  code: number;
  text: string;
}

/**
 * Parse a passive-mode reply into a host and port.
 *
 * A 227 looks like: `227 Entering Passive Mode (192,168,1,50,234,12).` The last
 * two numbers are the port as a big-endian pair, so 234,12 means 234*256+12.
 *
 * Returns undefined when the reply is not parseable, so the caller can fail
 * with a useful message rather than dialling a garbage port.
 */
export function parsePasv(text: string): { host: string; port: number } | undefined {
  const m = text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
  if (!m) return undefined;
  const n = m.slice(1).map((v) => Number(v));
  if (n.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return undefined;
  return { host: n.slice(0, 4).join("."), port: n[4] * 256 + n[5] };
}

/**
 * Parse an extended-passive reply. `229 Entering Extended Passive Mode (|||port|)`
 * carries only a port — the data connection reuses the control host.
 */
export function parseEpsv(text: string): number | undefined {
  const m = text.match(/\(\|\|\|(\d+)\|\)/);
  if (!m) return undefined;
  const port = Number(m[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * True for FTP replies that are not failures.
 *
 * RFC 959 splits replies by leading digit: 1xx positive preliminary ("command
 * accepted, in progress"), 2xx positive completion, 3xx positive intermediate
 * ("send more"), 4xx transient negative, 5xx permanent negative. Only 4xx and
 * 5xx are errors.
 *
 * This previously started at 200 and so treated `150 Opening data connection`
 * — the normal reply to STOR — as a rejection, which would have failed against
 * every real server.
 */
function isPositive(code: number): boolean {
  return code >= 100 && code < 400;
}

/**
 * A line-buffered FTP control channel over TLS.
 *
 * FTP replies can span several lines: a multi-line reply opens with
 * `250-text` and closes with `250 text` (same code, space instead of hyphen),
 * so we must not treat the first line as the whole reply.
 */
class ControlChannel {
  private buffer = "";
  private pending: Array<(reply: FtpReply | Error) => void> = [];
  /**
   * Replies that arrived with no reader waiting.
   *
   * This queue is load-bearing: the server sends `226 Transfer complete` as
   * soon as the data connection closes, which happens while we are still
   * awaiting the file stream rather than the control socket. Without somewhere
   * to park it, that reply was read off the socket and dropped, and the
   * subsequent read() waited for a message that had already been delivered.
   */
  private replies: FtpReply[] = [];

  constructor(
    private readonly socket: TLSSocket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.fail(err));
    socket.on("close", () => this.fail(new Error("FTPS control connection closed")));
  }

  private closed?: Error;

  private fail(err: Error): void {
    this.closed = err;
    const waiting = this.pending.splice(0);
    for (const resolve of waiting) resolve(err);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const reply = this.takeReply();
      if (!reply) return;
      const next = this.pending.shift();
      if (next) next(reply);
      else this.replies.push(reply);
    }
  }

  /** Pull one complete (possibly multi-line) reply out of the buffer. */
  private takeReply(): FtpReply | undefined {
    const lines = this.buffer.split(/\r?\n/);
    if (lines.length < 2) return undefined;

    const first = lines[0];
    const m = first.match(/^(\d{3})([ -])/);
    if (!m) {
      // Not a reply we understand; drop the line so we can't spin forever.
      this.buffer = lines.slice(1).join("\r\n");
      return undefined;
    }
    const code = Number(m[1]);
    if (m[2] === " ") {
      this.buffer = lines.slice(1).join("\r\n");
      return { code, text: first };
    }
    // Multi-line: scan for the terminator "<code> " at the start of a line.
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].startsWith(`${code} `)) {
        const text = lines.slice(0, i + 1).join("\n");
        this.buffer = lines.slice(i + 1).join("\r\n");
        return { code, text };
      }
    }
    return undefined; // terminator not received yet
  }

  /** Wait for the next reply. */
  read(): Promise<FtpReply> {
    // Serve anything that already arrived before waiting on the socket.
    const buffered = this.replies.shift();
    if (buffered) return Promise.resolve(buffered);
    // The socket died and nothing is queued — fail now rather than at timeout.
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`FTPS timed out after ${this.timeoutMs}ms waiting for a reply`)),
        this.timeoutMs,
      );
      this.pending.push((r) => {
        clearTimeout(timer);
        if (r instanceof Error) reject(r);
        else resolve(r);
      });
    });
  }

  /** Send a command and return its reply. */
  async send(command: string): Promise<FtpReply> {
    this.socket.write(`${command}\r\n`);
    return this.read();
  }

  /**
   * Send a command and throw unless the reply is positive. `what` names the
   * step so a failure says which one, rather than a bare FTP code.
   */
  async expect(command: string, what: string): Promise<FtpReply> {
    const reply = await this.send(command);
    if (!isPositive(reply.code)) {
      throw new Error(`${what} failed: ${reply.text.trim()}`);
    }
    return reply;
  }
}

function tlsOptions(host: string, port: number): ConnectionOptions {
  return {
    host,
    port,
    // Bambu printers present a self-signed certificate with no CA to validate
    // against, so verification cannot succeed. The connection is still
    // encrypted; this only forgoes authenticating the peer, which is the same
    // trade-off Bambu's own tooling makes on the LAN.
    rejectUnauthorized: false,
    // Their FTPS server negotiates older suites than Node's modern default.
    minVersion: "TLSv1.2",
  };
}

function openTls(host: string, port: number, timeoutMs: number, session?: Buffer): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ ...tlsOptions(host, port), session }, () => {
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`FTPS connection to ${host}:${port} timed out after ${timeoutMs}ms`));
    });
    socket.once("error", reject);
  });
}

/**
 * Upload one file over implicit FTPS.
 *
 * Sequence: connect (TLS first), authenticate, switch to binary, protect the
 * data channel, open a passive data connection, STOR, then wait for the
 * transfer-complete reply on the control channel.
 *
 * Throws with a plain-language message on any failure; callers turn that into
 * a SendJobResult rather than letting it escape.
 */
export async function ftpsUpload(opts: FtpsOptions): Promise<{ remoteName: string; bytes: number }> {
  const port = opts.port ?? BAMBU_FTPS_PORT;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const remoteName = opts.remoteName ?? basename(opts.localPath);
  const size = statSync(opts.localPath).size;

  const control = await openTls(opts.host, port, timeoutMs);
  const ch = new ControlChannel(control, timeoutMs);

  try {
    const greeting = await ch.read();
    if (!isPositive(greeting.code)) {
      throw new Error(`FTPS server refused the connection: ${greeting.text.trim()}`);
    }

    // 331 (need password) or 230 (already logged in) are both fine here.
    const user = await ch.send(`USER ${opts.user}`);
    if (user.code !== 230) {
      if (user.code !== 331) throw new Error(`Login rejected: ${user.text.trim()}`);
      const pass = await ch.send(`PASS ${opts.password}`);
      if (pass.code !== 230) {
        throw new Error(
          `Login failed — check the printer's LAN access code. (${pass.text.trim()})`,
        );
      }
    }

    await ch.expect("TYPE I", "Switching to binary mode");
    // Protect the data channel too. PBSZ 0 is required before PROT under TLS.
    await ch.expect("PBSZ 0", "Setting the protection buffer size");
    await ch.expect("PROT P", "Enabling data-channel encryption");

    if (opts.remoteDir) {
      await ch.expect(`CWD ${opts.remoteDir}`, `Entering directory ${opts.remoteDir}`);
    }

    // Prefer EPSV; fall back to PASV for servers that don't implement it.
    let dataHost = opts.host;
    let dataPort: number | undefined;
    const epsv = await ch.send("EPSV");
    if (isPositive(epsv.code)) {
      dataPort = parseEpsv(epsv.text);
    }
    if (dataPort === undefined) {
      const pasv = await ch.expect("PASV", "Opening a data connection");
      const parsed = parsePasv(pasv.text);
      if (!parsed) throw new Error(`Could not read the data port from: ${pasv.text.trim()}`);
      // Some servers report an unroutable address here (NAT). The control
      // host is the one we know reaches the printer, so keep it.
      dataHost = opts.host;
      dataPort = parsed.port;
    }

    // Many FTPS servers require the data connection to resume the control
    // channel's TLS session, as proof it belongs to the same client.
    const session = control.getSession();
    const data = await openTls(dataHost, dataPort, timeoutMs, session);
    // The data socket is torn down by whichever side finishes first, so a
    // reset here is routine. Keep a listener attached for its whole life;
    // without one, Node turns that reset into an uncaught exception.
    data.on("error", () => undefined);

    const stor = await ch.send(`STOR ${remoteName}`);
    if (!isPositive(stor.code)) {
      data.destroy();
      throw new Error(`Printer rejected the upload: ${stor.text.trim()}`);
    }

    await new Promise<void>((resolve, reject) => {
      const file = createReadStream(opts.localPath);
      const timer = setTimeout(() => {
        data.destroy();
        reject(new Error(`Upload stalled after ${timeoutMs}ms`));
      }, timeoutMs);
      const done = (err?: Error): void => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      file.on("error", done);
      data.once("error", done);
      data.on("close", () => done());
      file.pipe(data);
    });

    const complete = await ch.read();
    if (!isPositive(complete.code)) {
      throw new Error(`Transfer did not complete: ${complete.text.trim()}`);
    }

    await ch.send("QUIT").catch(() => undefined);
    return { remoteName, bytes: size };
  } finally {
    control.destroy();
  }
}
