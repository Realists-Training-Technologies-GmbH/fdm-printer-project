import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Readable } from "node:stream";
import EventEmitter2 from "eventemitter2";
import { HttpClientFactory } from "@/services/core/http-client.factory";
import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { PrusaLinkHttpPollingAdapter } from "@/services/prusa-link/prusa-link-http-polling.adapter";
import { PrusaLinkType } from "@/services/printer-api.interface";
import { PrusaBuddySimulator } from "@/services/prusa-link/testing/prusa-buddy-simulator";
import { FakePrusaLinkServer } from "@/services/prusa-link/testing/fake-prusalink-server";
import { silentLoggerFactory } from "@/services/prusa-link/testing/test-harness";

const settingsStore = { getTimeoutSettings: () => ({ apiTimeout: 5000, apiUploadTimeout: 30000 }) } as any;

function buildApi(server: FakePrusaLinkServer, baseUrl: string) {
  const emitter = new EventEmitter2();
  const httpClientFactory = new HttpClientFactory(settingsStore);
  const login = {
    printerURL: baseUrl,
    username: server.username,
    password: server.password,
    apiKey: "",
    printerType: PrusaLinkType,
  } as any;
  const api = new PrusaLinkApi(silentLoggerFactory, emitter, httpClientFactory, settingsStore, login);
  const adapter = new PrusaLinkHttpPollingAdapter(silentLoggerFactory, api, emitter);
  adapter.registerCredentials({ printerId: 1, loginDto: login } as any);

  const currentEvents: any[] = [];
  emitter.on("prusalink.current", (e) => currentEvents.push(e));
  return { api, adapter, emitter, currentEvents, login };
}

describe("PrusaLink adapter over real HTTP + digest auth", () => {
  let server: FakePrusaLinkServer;

  afterEach(async () => {
    await server?.stop();
  });

  it("polls a Buddy (XL) and emits the live PRINTING state through the real pipeline", async () => {
    const sim = new PrusaBuddySimulator({ mode: "buddy" }).startPrint({ display: "part.bgcode" }).progress(40);
    server = new FakePrusaLinkServer(sim);
    const baseUrl = await server.start();
    const { adapter, currentEvents } = buildApi(server, baseUrl);

    await (adapter as any).pollOnce();

    expect(currentEvents).toHaveLength(1);
    const payload = currentEvents[0].payload;
    expect(payload.state.text.toUpperCase()).toBe("PRINTING");
    expect(payload.state.flags.printing).toBe(true);
    expect(payload.job.file.display).toBe("part.bgcode");
    expect(payload.progress.completion).toBeCloseTo(40, 5);

    // The real digest handshake happened: every endpoint got an unauthorized
    // probe (401) followed by an authorized retry.
    const paths = new Set(server.requests.map((r) => r.url.split("?")[0]));
    expect(paths).toContain("/api/printer");
    expect(paths).toContain("/api/job");
    expect(paths).toContain("/api/v1/status");
    expect(server.requests.some((r) => !r.hadAuth)).toBe(true); // 401 probe
    expect(server.requests.some((r) => r.hadAuth)).toBe(true); // authed retry
  });

  it("Einsy: resolves state from /api/printer link_state when /api/v1/status is unavailable", async () => {
    const sim = new PrusaBuddySimulator({ mode: "einsy" }).startPrint().pause();
    server = new FakePrusaLinkServer(sim);
    server.statusFailCode = 503; // the v1 status read fails (caught → null)
    const baseUrl = await server.start();
    const { adapter, currentEvents } = buildApi(server, baseUrl);

    await (adapter as any).pollOnce();

    expect(currentEvents).toHaveLength(1);
    expect(currentEvents[0].payload.state.text.toUpperCase()).toBe("PAUSED");
    expect(currentEvents[0].payload.state.flags.paused).toBe(true);
  });

  it("uploads a file over PUT with digest auth and Print-After-Upload", async () => {
    const sim = new PrusaBuddySimulator({ mode: "buddy" }).idle();
    server = new FakePrusaLinkServer(sim);
    const baseUrl = await server.start();
    const { api } = buildApi(server, baseUrl);

    await api.uploadFile({
      stream: Readable.from([Buffer.alloc(256)]),
      fileName: "test.bgcode",
      contentLength: 256,
      startPrint: true,
      uploadToken: "t1",
    } as any);

    expect(server.uploads).toHaveLength(1);
    expect(server.uploads[0].url).toContain("test.bgcode");
    expect(server.uploads[0].printAfterUpload).toBe("?1"); // start-after-upload
    expect(server.uploads[0].bytes).toBe(256);
  });
});
