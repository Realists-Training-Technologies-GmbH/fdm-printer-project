import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

function parseAuthParams(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = header.replace(/^Digest\s+/i, "");
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? "";
  return out;
}

export interface RecordedRequest {
  method: string;
  url: string;
  hadAuth: boolean;
  nc?: string;
}

export interface RecordedUpload {
  url: string;
  bytes: number;
  printAfterUpload?: string;
  overwrite?: string;
  contentType?: string;
}

/**
 * Minimal but real PrusaLink HTTP server for end-to-end adapter tests. Speaks
 * HTTP Digest (RFC 7616, qop=auth) exactly like the firmware, and serves the
 * poll endpoints from a PrusaBuddySimulator so the REAL PrusaLinkApi +
 * PrusaLinkHttpPollingAdapter exercise the actual network/digest/normalize path
 * — not stubbed objects.
 */
export class FakePrusaLinkServer {
  private server?: Server;
  readonly username = "maker";
  readonly password = "s3cr3t";
  readonly requests: RecordedRequest[] = [];
  readonly uploads: RecordedUpload[] = [];
  /** Set to a status code to force /api/v1/status to fail (tests the fallback). */
  statusFailCode: number | null = null;

  constructor(private readonly sim: PrusaBuddySimulator) {}

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private challenge(res: ServerResponse) {
    const nonce = randomBytes(16).toString("hex");
    const opaque = randomBytes(8).toString("hex");
    res.setHeader(
      "WWW-Authenticate",
      `Digest realm="PrusaLink", qop="auth", nonce="${nonce}", opaque="${opaque}", algorithm=MD5`,
    );
    res.statusCode = 401;
    res.end("Unauthorized");
  }

  // Validate the client's digest response against our known password.
  private digestOk(method: string, auth: string): boolean {
    const p = parseAuthParams(auth);
    if (p.username !== this.username || !p.nonce || !p.uri || !p.response) return false;
    const ha1 = md5(`${this.username}:${p.realm ?? "PrusaLink"}:${this.password}`);
    const ha2 = md5(`${method}:${p.uri}`);
    const expected = p.qop
      ? md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`)
      : md5(`${ha1}:${p.nonce}:${ha2}`);
    return expected === p.response;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? "";
    const method = req.method ?? "GET";
    const auth = req.headers["authorization"];

    this.requests.push({ method, url, hadAuth: !!auth, nc: auth ? parseAuthParams(auth).nc : undefined });

    if (!auth) return this.challenge(res);
    if (!this.digestOk(method, auth)) return this.challenge(res);

    // Consume the body (PUT uploads) regardless, then route.
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    await new Promise<void>((resolve) => req.on("end", () => resolve()));
    const body = Buffer.concat(chunks);

    const json = (obj: unknown, code = 200) => {
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(obj));
    };

    const path = url.split("?")[0];

    if (method === "GET" && path === "/api/version") {
      return json({
        api: "2.0.0",
        server: "2.1.2",
        text: "PrusaLink XL",
        hostname: "sim-xl",
        nozzle_diameter: 0.4,
        capabilities: { "upload-by-put": true },
      });
    }
    if (method === "GET" && path === "/api/printer") return json(this.sim.getPrinterStateResponse());
    if (method === "GET" && path === "/api/job") return json(this.sim.getJobStateResponse());
    if (method === "GET" && path === "/api/v1/status") {
      if (this.statusFailCode) {
        res.statusCode = this.statusFailCode;
        return res.end("status unavailable");
      }
      return json(this.sim.getStatusResponse());
    }
    if (method === "GET" && path === "/api/v1/storage") {
      return json({ storage_list: [{ name: "usb", path: "/usb/", available: true, read_only: false }] });
    }
    if (method === "PUT" && path.startsWith("/api/v1/files/")) {
      this.uploads.push({
        url: path,
        bytes: body.length,
        printAfterUpload: req.headers["print-after-upload"] as string | undefined,
        overwrite: req.headers["overwrite"] as string | undefined,
        contentType: req.headers["content-type"] as string | undefined,
      });
      return json({ name: path.split("/").pop() }, 201);
    }
    if (method === "POST" && path.startsWith("/api/v1/files/")) {
      res.statusCode = 204;
      return res.end();
    }

    res.statusCode = 404;
    res.end("not found");
  }
}
