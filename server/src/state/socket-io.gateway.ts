import { Server, Socket } from "socket.io";
import { socketIoConnectedEvent } from "@/constants/event.constants";
import { SettingsStore } from "@/state/settings.store";
import EventEmitter2 from "eventemitter2";
import { LoggerService } from "@/handlers/logger";
import type { ILoggerFactory } from "@/handlers/logger-factory";
import { Server as HttpServer } from "http";
import { getPassportJwtOptions, verifyUserCallback } from "@/middleware/passport";
import type { IConfigService } from "@/services/core/config.service";
import type { IUserService } from "@/services/interfaces/user-service.interface";
import { authorize } from "@/middleware/socketio.middleware";
import { Counter, Gauge } from "prom-client";

const socketIoGatewaySessions = new Gauge({
  name: "socketio_gateway_sessions",
  help: "Gateway active sessions",
});

const socketIoGatewayDisconnects = new Counter({
  name: "socketio_gateway_disconnects",
  help: "Gateway connections closed",
});

const socketIoGatewayMessagesSent = new Counter({
  name: "socketio_messages_sent",
  help: "Gateway messages sent",
});

const socketIoGatewayMessageSentSize = new Gauge({
  name: "socketio_message_size",
  help: "Gateway message sent size",
});

export class SocketIoGateway {
  logger: LoggerService;

  io: Server;

  constructor(
    loggerFactory: ILoggerFactory,
    private readonly eventEmitter2: EventEmitter2,
    private readonly settingsStore: SettingsStore,
    private readonly userService: IUserService,
    private readonly configService: IConfigService,
  ) {
    this.logger = loggerFactory(SocketIoGateway.name);
  }

  attachServer(httpServer: HttpServer) {
    this.io = new Server(httpServer, { cors: { origin: "*" } });
    const opts = getPassportJwtOptions(
      this.settingsStore,
      this.configService,
      (value: Socket) => value.handshake.auth.token,
    );
    this.io.use(authorize(this.settingsStore, opts, this.logger, verifyUserCallback(this.userService)));
    this.io.on("connection", (socket) => this.onConnect.bind(this)(socket));
  }

  onConnect(socket: Socket) {
    this.logger.debug("SocketIO Client connected", { socketId: socket.id });
    this.eventEmitter2.emit(socketIoConnectedEvent, socket.id);
    socketIoGatewaySessions.inc();

    socket.on("disconnect", () => {
      this.logger.debug("SocketIO Client disconnected", { socketId: socket.id });
      socketIoGatewaySessions.dec(1);
      socketIoGatewayDisconnects.inc();
    });
  }

  send<T>(event: string, data: T) {
    if (!this.io) {
      this.logger.debug(`Cant send event ${event}, socketio gateway must be created first`);
      return;
    }

    this.io.emit(event, data);
    socketIoGatewayMessagesSent.inc();

    const payload = JSON.stringify(data);
    const sizeInBytes = Buffer.byteLength(payload);
    socketIoGatewayMessageSentSize.set(sizeInBytes);
  }
}

export const IO_MESSAGES = {
  Update: "update",
  // Per-printer notification fired when the cached thumbnail row changes
  // (e.g. a new print started). Lets the client invalidate TanStack queries
  // for that printer without waiting for window focus / staleTime.
  PrinterThumbnailChanged: "printer.thumbnailChanged",
  // Outcome of an async queue dispatch — surfaces success/failure of the
  // background upload to the user as a toast instead of letting them stare
  // at a chip that silently flips back to QUEUED.
  QueueEvent: "printQueue.event",
  // Terminal-state events for an active print: completed / failed /
  // cancelled. Used client-side to fire browser notifications so the
  // operator hears about a 24-hour print finishing without having the
  // dashboard tab in focus.
  PrintJobEvent: "printJob.event",
  // Intake inbox changed (a file arrived via the API, or an item was
  // archived/dispatched/discarded). Lets the client refresh the list and
  // its menu badge, and toast newly-arrived uploads.
  IntakeEvent: "intake.event",
};
