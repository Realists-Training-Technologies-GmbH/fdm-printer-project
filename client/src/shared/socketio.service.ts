import { SocketIoUpdateMessage } from "@/models/socketio-messages/socketio-message.model";
import { usePrinterStore } from "@/store/printer.store";
import { useFloorStore } from "@/store/floor.store";
import { usePrinterStateStore } from "@/store/printer-state.store";
import { useTestPrinterStore } from "@/store/test-printer.store";
import { useSnackbar } from "./snackbar.composable";
import { getBaseUri } from "@/shared/http-client";
import { useAuthStore } from "@/store/auth.store";
import { useTrackedUploadsStore } from "@/store/tracked-uploads.store";
import { io, Socket } from "socket.io-client";
import { reactive } from "vue";
import { useEventBus } from "@vueuse/core";
import { useDebugSocketStore } from "@/store/debug-socket.store";
import { useOverlayStore } from "@/store/overlay.store";
import { notifyPrinterThumbnailChanged } from "@/shared/printer-thumbnail-invalidator.composable";
import { useBrowserNotifications } from "@/shared/notifications.composable";

enum IO_MESSAGES {
  Update = "update",
  TestPrinterState = "test-printer-state",
  // Mirrors server/src/state/socket-io.gateway.ts IO_MESSAGES. Keep these
  // in sync; we don't have a shared types package between the two yet.
  PrinterThumbnailChanged = "printer.thumbnailChanged",
  QueueEvent = "printQueue.event",
  PrintJobEvent = "printJob.event",
}

interface QueueEventPayload {
  kind: "submitted" | "failed";
  printerId?: number;
  jobId?: number;
  reason?: string;
  // Server sets `cancelled: true` on the failed event when the dispatch
  // was aborted by user request (vs. a real upload failure). Client uses
  // it to pick a friendlier toast — same code path, different copy.
  cancelled?: boolean;
}

interface PrinterThumbnailChangedPayload {
  printerId: number;
  jobId?: number;
}

interface PrintJobEventPayload {
  kind: "completed" | "failed" | "cancelled";
  jobId: number;
  printerId: number;
  fileName: string;
  reason?: string;
  actualTimeSeconds?: number;
}

let appSocketIO: Socket | null = null;
export const socketState = reactive({
  connected: false,
  setup: false,
  id: "",
  active: false,
});

export class SocketIoService {
  private readonly printerStore = usePrinterStore();
  private readonly floorStore = useFloorStore();
  private readonly printerStateStore = usePrinterStateStore();
  private readonly testPrinterStore = useTestPrinterStore();
  private readonly trackedUploadsStore = useTrackedUploadsStore();
  private readonly debugSocketStore = useDebugSocketStore();
  private readonly appLoaderStore = useOverlayStore();
  private readonly snackbar = useSnackbar();
  private readonly authStore = useAuthStore();

  socketState() {
    if (!appSocketIO) {
      console.debug("Returning default socket state, socket was not set up");
      return { setup: false };
    }

    return {
      setup: true,
      connected: appSocketIO.connected,
      active: appSocketIO.active,
      id: appSocketIO.id,
    };
  }

  async setupSocketConnection() {
    // Skip Socket.IO setup in screenshot/test mode
    if ((window as any).__DISABLE_SOCKETIO__ || (window as any).__SCREENSHOT_MODE__) {
      console.debug("Socket.IO disabled (test/screenshot mode)");
      socketState.setup = true;
      socketState.connected = true;
      socketState.active = true;
      socketState.id = "test-mode-socket";

      // Inject mock Socket.IO data into stores if available
      const mockData = (window as any).__SOCKETIO_MOCK_DATA__;
      if (mockData) {
        this.onMessage(mockData);
      }

      return;
    }

    console.debug("Setting up socket.io client");

    if (socketState.setup) {
      throw new Error("Cant setup socket, socket already created");
    }
    socketState.setup = false;

    const apiBase = await getBaseUri();
    this.authStore.loadTokens();

    appSocketIO = io(apiBase, {
      auth: async (cb) => {
        if (!this.authStore.loginRequired) {
          return cb({});
        }

        try {
          if (this.authStore.isLoginExpired) {
            console.warn("Login expired, attempting to refresh token");
            await this.authStore.refreshLoginToken();
          }

          if (this.authStore.token) {
            cb({ token: this.authStore.token });
          } else {
            console.error("No token available after refresh");
            cb({});
          }
        } catch (err) {
          console.error("Token refresh failed:", err);
          cb({});
        }
      },
    });

    this.setupConnectionHandlers();
    this.registerMessageHandlers();

    socketState.setup = true;
  }

  disconnect() {
    if (!appSocketIO) {
      throw new Error("Cant disconnect socket, socket not created");
    }

    appSocketIO.close();
    appSocketIO = null;
    socketState.setup = false;
    socketState.connected = false;
    socketState.active = false;
    socketState.id = "";
  }

  reconnect() {
    // Skip reconnect in test/screenshot mode
    if ((window as any).__DISABLE_SOCKETIO__ || (window as any).__SCREENSHOT_MODE__) {
      console.debug("Socket.IO reconnect skipped (test/screenshot mode)");
      return;
    }

    if (!appSocketIO) {
      throw new Error("Cant reconnect socket, socket not created");
    }

    console.debug("Resetting socket connection. Previous state:", {
      connected: appSocketIO.connected,
      active: appSocketIO.active,
      id: appSocketIO.id,
    });

    appSocketIO.close();
    appSocketIO.connect();
  }

  onMessage(message: SocketIoUpdateMessage) {
    if (message.trackedUploads.current?.length) {
      this.trackedUploadsStore.setUploads(message?.trackedUploads.current);

      this.trackedUploadsStore.activeUploads.forEach((u) => {
        this.snackbar.openProgressMessage(
          u.correlationToken,
          u.multerFile.originalname,
          (u.progress || 0) * 100,
          u.completed,
        );
      });
    }

    if (message.floors?.length) {
      this.floorStore.saveFloors(message.floors);
    }

    if (message.printers?.length) {
      this.printerStore.setPrinters(message.printers);
    }

    if (message.socketStates) {
      this.printerStateStore.setSocketStates(message.socketStates);
    }

    if (message.printerEvents) {
      this.printerStateStore.setPrinterEvents(message.printerEvents);
    }

    // queueUploads is the per-printer transfer progress for in-flight queue
    // dispatches — null/missing is the steady state, so write an empty
    // object rather than leaving the previous snapshot around.
    this.printerStateStore.setQueueUploads(message.queueUploads ?? {});
  }

  private setupConnectionHandlers() {
    if (!appSocketIO) {
      throw new Error("Cant bind socket events, socket not created");
    }

    appSocketIO.on("connect", () => {
      socketState.id = appSocketIO?.id ?? "";
      socketState.connected = true;
      socketState.active = appSocketIO?.active ?? false;
      console.debug("Socket connected:", socketState.id, "Active:", socketState.active);
      this.appLoaderStore.setServerDisconnected(false);
      this.appLoaderStore.resetRetry();
    });

    appSocketIO.on("disconnect", () => {
      socketState.id = "";
      socketState.connected = false;
      socketState.active = false;
      console.debug("Socket disconnected");
      this.appLoaderStore.setServerDisconnected(true);

      // Trigger backend retry loop
      const retryEventBus = useEventBus('backend:start-retry');
      retryEventBus.emit();
    });

    appSocketIO.on("connect_error", async (error) => {
      console.error("Socket connection error:", error.message);
      if (error.message.includes("Authentication") || error.message.includes("jwt") ||
        error.message.includes("token") || error.message.includes("auth")) {
        console.warn("Possible JWT authentication issue detected");
        try {
          await this.authStore.refreshLoginToken();
          this.reconnect();
        } catch (e) {
          console.error("Error refreshing token");
          this.disconnect();
          await this.authStore.logout();
        }
      } else {
        this.appLoaderStore.setServerDisconnected(true);
      }
    });
  }

  private registerMessageHandlers() {
    if (!appSocketIO) {
      throw new Error("Cant bind socket app events, socket not created");
    }

    // Register catch-all handler for debugging
    appSocketIO.onAny((event, ...args) => {
      this.debugSocketStore.logMessage("in", event, args.length === 1 ? args[0] : args);
    });

    // Register legacy update handler
    appSocketIO.on(IO_MESSAGES.Update, (data) => this.onMessage(data));

    // Register test printer state handler
    appSocketIO.on(IO_MESSAGES.TestPrinterState, (data) => {
      this.testPrinterStore.saveEvent(data);
    });

    // Background-dispatch outcome → toast. We respond immediately to the
    // POST /process with 202 so the user has no way of knowing whether the
    // upload eventually succeeded without this event.
    appSocketIO.on(IO_MESSAGES.QueueEvent, (data: QueueEventPayload) => {
      const printerLabel = data.printerId
        ? this.printerStore.printer(data.printerId)?.name ?? `printer ${data.printerId}`
        : "printer";
      if (data.kind === "failed") {
        if (data.cancelled) {
          // Cancel-by-user is informational, not an error. Match the
          // "X cancelled" wording used elsewhere for terminal cancels.
          this.snackbar.openInfoMessage({
            title: `Dispatch to ${printerLabel} cancelled`,
            warning: true,
          });
        } else {
          // `data.reason` is the persisted `statusReason` — usually
          // "Print submission failed: <friendly>". The toast title
          // already says "failed", so strip the redundant prefix and
          // any leaked JSON noise before showing.
          const cleanReason = (data.reason ?? "")
            .replace(/^Print submission failed:\s*/i, "")
            .trim();
          this.snackbar.openErrorMessage({
            title: `Dispatch to ${printerLabel} failed`,
            subtitle: cleanReason || "Unknown error",
          });
        }
      } else if (data.kind === "submitted") {
        this.snackbar.openInfoMessage({
          title: `Dispatched job to ${printerLabel}`,
        });
      }
    });

    // Thumbnail cache flipped to a new file (e.g. a new print started) —
    // invalidate the grid tile's TanStack query via an event-bus emit so
    // the new preview shows up without window focus / staleTime expiry.
    appSocketIO.on(IO_MESSAGES.PrinterThumbnailChanged, (data: PrinterThumbnailChangedPayload) => {
      if (typeof data?.printerId === "number") {
        notifyPrinterThumbnailChanged({ printerId: data.printerId, jobId: data.jobId });
      }
    });

    // Print lifecycle terminal transitions → browser notification AND
    // toast. The user might be away from the dashboard tab when a 24h
    // print finishes; the notification gets the operator's attention even
    // with the tab in the background. Toast covers the foreground case.
    const notifications = useBrowserNotifications();
    appSocketIO.on(IO_MESSAGES.PrintJobEvent, (data: PrintJobEventPayload) => {
      const printerName = this.printerStore.printer(data.printerId)?.name ?? `printer ${data.printerId}`;
      if (data.kind === "completed") {
        const minutes = data.actualTimeSeconds ? Math.round(data.actualTimeSeconds / 60) : null;
        const body = minutes ? `${data.fileName} · ${minutes} min` : data.fileName;
        notifications.notify(`${printerName} · Print complete`, {
          body,
          tag: `printJob-${data.jobId}`,
        });
        this.snackbar.openInfoMessage({
          title: `${printerName} finished printing`,
          subtitle: data.fileName,
        });
      } else if (data.kind === "failed") {
        notifications.notify(`${printerName} · Print failed`, {
          body: data.reason ?? data.fileName,
          tag: `printJob-${data.jobId}`,
        });
        this.snackbar.openErrorMessage({
          title: `${printerName}: print failed`,
          subtitle: data.reason ?? data.fileName,
        });
      } else if (data.kind === "cancelled") {
        // Cancelled is a deliberate user action; skip the high-priority
        // browser notification to avoid spamming the operator with their
        // own clicks, but still toast for visibility.
        this.snackbar.openInfoMessage({
          title: `${printerName}: print cancelled`,
          subtitle: data.fileName,
          warning: true,
        });
      }
    });
  }
}
