import type { ClientMessage, PlayerCommand, ServerMessage, ServerSnapshot, ServerWelcome } from "@tac/shared";
import { websocketUrl } from "./serverConfig";

type Listener = (message: ServerMessage) => void;

export class GameConnection {
  private socket?: WebSocket;
  private listeners = new Set<Listener>();
  welcome?: ServerWelcome;
  snapshot?: ServerSnapshot;
  seq = 0;

  connect(debug = false): void {
    const token = localStorage.getItem("tac-reconnect-token") ?? undefined;
    this.socket = new WebSocket(websocketUrl());
    this.socket.addEventListener("open", () => {
      this.send(token ? { type: "hello", roomId: "local", reconnectToken: token, debug } : { type: "hello", roomId: "local", debug });
    });
    this.socket.addEventListener("message", (event) => {
      const message = parseServerMessage(event.data);
      if (!message) return;
      if (message.type === "welcome") {
        this.welcome = message;
        localStorage.setItem("tac-reconnect-token", message.reconnectToken);
      }
      if (message.type === "snapshot") this.snapshot = message;
      for (const listener of this.listeners) listener(message);
    });
  }

  onMessage(listener: Listener): void {
    this.listeners.add(listener);
  }

  command(command: Omit<PlayerCommand, "type" | "seq" | "tick">): void {
    this.send({ type: "command", seq: ++this.seq, tick: this.snapshot?.tick ?? 0, ...command });
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as ServerMessage;
  } catch {
    console.warn("Ignoring non-JSON WebSocket message from game server", data.slice(0, 120));
    return null;
  }
}
