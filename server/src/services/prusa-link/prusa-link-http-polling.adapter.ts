import { PrusaLinkType } from "@/services/printer-api.interface";
import { PrusaLinkApi } from "@/services/prusa-link/prusa-link.api";
import { LoggerService } from "@/handlers/logger";
import EventEmitter2 from "eventemitter2";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import type { IWebsocketAdapter } from "@/services/websocket-adapter.interface";
import type { ISocketLogin } from "@/shared/dtos/socket-login.dto";
import type { LoginDto } from "@/services/interfaces/login.dto";
import { SOCKET_STATE, SocketState } from "@/shared/dtos/socket-state.type";
import { API_STATE, ApiState } from "@/shared/dtos/api-state.type";
import { errorSummary } from "@/utils/error.utils";
import { prusaLinkEvent } from "@/services/prusa-link/constants/prusalink.constants";
import type { PrusaLinkEventDto } from "@/services/prusa-link/constants/prusalink-event.dto";
import { normalizePrusaLinkPoll } from "@/services/prusa-link/utils/normalize-poll";
import { WsMessage } from "@/shared/ws-message.constants";
import { AppConstants } from "@/server.constants";

const defaultLog = { adapter: "prusa-link" };

export class PrusaLinkHttpPollingAdapter implements IWebsocketAdapter {
  public readonly printerType = PrusaLinkType;
  public printerId?: number;
  login: LoginDto;
  socketState: SocketState;
  apiState: ApiState;
  lastMessageReceivedTimestamp: null | number;
  protected logger: LoggerService;
  private refreshPrinterCurrentInterval?: NodeJS.Timeout;
  private pollInFlight: boolean = false;
  private consecutiveFailures: number = 0;

  private eventEmittingAllowed: boolean = true;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly prusaLinkApi: PrusaLinkApi,
    private readonly eventEmitter2: EventEmitter2,
  ) {
    this.logger = loggerFactory(PrusaLinkHttpPollingAdapter.name);
  }

  public allowEmittingEvents() {
    this.eventEmittingAllowed = true;
  }

  public disallowEmittingEvents() {
    this.eventEmittingAllowed = false;
  }

  needsReopen(): boolean {
    // TODO this can be standardized
    return !this.refreshPrinterCurrentInterval;
  }

  needsSetup(): boolean {
    // TODO this can be standardized
    return !this.refreshPrinterCurrentInterval;
  }

  needsReauth(): boolean {
    throw new Error("Method not implemented.");
  }

  isClosedOrAborted(): boolean {
    throw new Error("Method not implemented.");
  }

  reauthSession(): Promise<void> {
    throw new Error("Method not implemented.");
  }

  registerCredentials(socketLogin: ISocketLogin): void {
    this.login = socketLogin.loginDto;
    this.printerId = socketLogin.printerId;
  }

  open(): void {
    this.startPolling();
  }

  close(): void {
    this.logger.debug("Polling adapter attempting stoppage.", this.logMeta());
    this.stopPolling();
  }

  setupSocketSession(): Promise<void> {
    this.logger.warn("SetupSocketSession", defaultLog);
    return Promise.resolve();
  }

  resetSocketState(): void {
    this.logger.warn("ResetSocketState", defaultLog);
  }

  startPolling() {
    this.stopPolling(); // Ensure no duplicate intervals exist

    const intervalMs = this.resolvePollIntervalMs();
    this.logger.debug(`Polling adapter starting at ${intervalMs}ms interval.`, this.logMeta());

    this.refreshPrinterCurrentInterval = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
  }

  /**
   * Read the env-configured polling cadence, clamped to a sane range so a
   * typo can't melt the printer's HTTP server (e.g. `PRUSA_LINK_POLL_INTERVAL_MS=1`).
   */
  private resolvePollIntervalMs(): number {
    const raw = process.env[AppConstants.PRUSA_LINK_POLL_INTERVAL_MS];
    if (!raw) return AppConstants.defaultPrusaLinkPollIntervalMs;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return AppConstants.defaultPrusaLinkPollIntervalMs;
    return Math.min(AppConstants.maxPrusaLinkPollIntervalMs, Math.max(AppConstants.minPrusaLinkPollIntervalMs, parsed));
  }

  private async pollOnce(): Promise<void> {
    if (!this.printerId) {
      this.logger.warn("Printer ID is not set, skipping status check.", this.logMeta());
      this.stopPolling();
      return;
    }

    // PrusaLink's HTTP server is single-threaded and slow under digest auth.
    // If the previous tick is still in flight, skip this one rather than
    // stacking parallel requests that would all time out together.
    if (this.pollInFlight) {
      this.logger.debug("Previous PrusaLink poll still in flight, skipping tick.", this.logMeta());
      return;
    }
    this.pollInFlight = true;

    this.updateSocketState(SOCKET_STATE.opening);
    try {
      this.prusaLinkApi.login = {
        printerURL: this.login.printerURL,
        username: this.login.username,
        password: this.login.password,
        apiKey: "",
        printerType: PrusaLinkType,
      };
      this.updateSocketState(SOCKET_STATE.authenticating);
      // These reads run sequentially on purpose. HTTP Digest auth uses a
      // per-nonce request counter (`nc`) that must increase monotonically;
      // firing the three GETs concurrently makes them race on the shared
      // counter. Buddy firmware (MK4) tolerates out-of-order nc, but the
      // standalone PrusaLink on a Raspberry Pi (MK3/MK2.5) validates it
      // strictly and 401s whichever request loses the race. Serialising
      // keeps the nc sequence clean for every PrusaLink variant; the
      // latency cost is a few tens of ms per 5s poll.
      const printerState = await this.prusaLinkApi.getPrinterState();
      const jobState = await this.prusaLinkApi.getJobState();
      const status = await this.prusaLinkApi.getStatus().catch(() => null);
      this.updateSocketState(SOCKET_STATE.authenticated);
      this.updateApiState(API_STATE.responding);
      this.consecutiveFailures = 0;

      // Normalize the three reads into the `current` event payload. Extracted
      // to a pure function (normalize-poll.ts) so the firmware simulator and
      // unit tests can exercise the exact same mapping without HTTP/digest.
      const payload = normalizePrusaLinkPoll(printerState, jobState, status);
      await this.emitEvent("current", payload);
    } catch (error) {
      this.updateSocketState(SOCKET_STATE.error);

      // Throttle log noise on any sustained failure (printer offline, slow, or
      // rejecting credentials) — we'd otherwise spam the log every poll tick.
      // After 3 consecutive failures, only log once per minute (every 12th
      // tick at the 5s default cadence).
      this.consecutiveFailures++;
      const shouldLog = this.consecutiveFailures <= 3 || this.consecutiveFailures % 12 === 0;
      if (shouldLog) {
        // An unreachable printer or bad credentials is an expected operational
        // condition, not a code bug, so log a one-line reason without Axios's
        // internal stack trace. Unexpected errors still get the full summary.
        const reason = this.pollFailureReason(error);
        if (reason) {
          this.logger.warn(`PrusaLink poll failed — ${reason}`, this.logMeta());
        } else {
          this.logger.error(`Failed to fetch PrusaLink status ${errorSummary(error)}`, this.logMeta());
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * Classify an expected, transient poll failure (printer offline, slow, or
   * rejecting credentials) into a short human-readable reason. Returns null
   * for anything unexpected so the caller falls back to a full error summary.
   */
  private pollFailureReason(error: any): string | null {
    const status = error?.response?.status;
    if (status === 401 || status === 403) return `auth rejected (${status})`;

    const code = error?.code;
    if (code === "ECONNABORTED" || /timeout/i.test(error?.message ?? "")) return "request timed out";
    if (code === "ECONNREFUSED") return "connection refused";
    if (code === "ECONNRESET") return "connection reset";
    if (code === "ETIMEDOUT") return "connection timed out";
    if (code === "EHOSTUNREACH") return "host unreachable";
    if (code === "ENETUNREACH") return "network unreachable";
    if (code === "ENOTFOUND") return "DNS lookup failed";
    return null;
  }

  stopPolling() {
    if (this.refreshPrinterCurrentInterval) {
      this.logger.debug("Polling adapter stopping, clearing interval.", this.logMeta());
      clearInterval(this.refreshPrinterCurrentInterval);
      this.refreshPrinterCurrentInterval = undefined;
      this.updateSocketState(SOCKET_STATE.closed);
    }
  }

  private async emitEvent(event: string, payload?: any) {
    if (!this.eventEmittingAllowed) {
      return;
    }

    this.logger.debug(`Emitting event ${prusaLinkEvent(event)}`, this.logMeta());
    await this.eventEmitter2.emitAsync(prusaLinkEvent(event), {
      event,
      payload,
      printerId: this.printerId,
      printerType: PrusaLinkType,
    } as PrusaLinkEventDto);
  }

  private emitEventSync(event: string, payload: any): void {
    if (!this.eventEmittingAllowed) {
      return;
    }

    this.eventEmitter2.emit(prusaLinkEvent(event), {
      event,
      payload,
      printerId: this.printerId,
      printerType: PrusaLinkType,
    } as PrusaLinkEventDto);
  }

  private updateSocketState(state: SocketState): void {
    this.socketState = state;
    this.emitEventSync(WsMessage.WS_STATE_UPDATED, state);
  }

  private updateApiState(state: ApiState): void {
    this.apiState = state;
    this.emitEventSync(WsMessage.API_STATE_UPDATED, state);
  }

  private logMeta() {
    return { ...defaultLog, printerId: this.printerId };
  }
}
