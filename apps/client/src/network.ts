import type { ClientMessage, PlayerCommand, ServerMessage, ServerSnapshot, ServerWelcome } from "@tac/shared";

type Listener = (message: ServerMessage) => void;

export class GameConnection {
  private socket?: WebSocket;
  private listeners = new Set<Listener>();
  welcome?: ServerWelcome;
  snapshot?: ServerSnapshot;
  seq = 0;

  connect(debug = false): void {
    const token = localStorage.getItem("tac-reconnect-token") ?? undefined;
    this.socket = new WebSocket("ws://localhost:8787");
    this.socket.addEventListener("open", () => {
      this.send(token ? { type: "hello", roomId: "local", reconnectToken: token, debug } : { type: "hello", roomId: "local", debug });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as ServerMessage;
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
