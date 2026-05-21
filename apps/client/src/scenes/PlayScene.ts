import Phaser from "phaser";
import type { PlayerCommand, PlayerId, RoomSummary, ServerMessage, ServerSnapshot, ServerWelcome } from "@tac/shared";
import { listMaps, listRooms } from "../editorApi";
import { mapSummaryToPickable, pickFromList } from "../fuzzyPicker";
import { colors, drawMap, drawPlayer } from "../render";

export class PlayScene extends Phaser.Scene {
  private socket: WebSocket | undefined = undefined;
  private welcome: ServerWelcome | undefined = undefined;
  private snapshot: ServerSnapshot | undefined = undefined;
  private seq = 0;
  private mapLayer: Phaser.GameObjects.Graphics | undefined = undefined;
  private entityLayer: Phaser.GameObjects.Graphics | undefined = undefined;
  private shell: HTMLElement | undefined = undefined;
  private hud: HTMLElement | undefined = undefined;
  private keys: Record<string, Phaser.Input.Keyboard.Key> | undefined = undefined;

  constructor() {
    super("play");
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.bg);
    this.mapLayer = this.add.graphics();
    this.entityLayer = this.add.graphics();
    this.keys = this.input.keyboard?.addKeys("W,A,S,D") as Record<string, Phaser.Input.Keyboard.Key>;
    this.createLobby();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.shell?.remove());
  }

  update(): void {
    if (!this.snapshot || !this.welcome || !this.keys) return;
    const pointer = this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const aim = Math.atan2(world.y - this.snapshot.self.position.y, world.x - this.snapshot.self.position.x);
    const command: Omit<PlayerCommand, "type" | "seq" | "tick"> = {
      move: {
        x: Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown),
        y: Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown)
      },
      aim,
      fire: false,
      use: "none"
    };
    this.send({ type: "command", seq: ++this.seq, tick: this.snapshot.tick, ...command });
    this.cameras.main.centerOn(this.snapshot.self.position.x, this.snapshot.self.position.y);
  }

  private createLobby(): void {
    this.shell = document.createElement("main");
    this.shell.className = "play-shell";
    this.shell.innerHTML = `
      <section class="play-panel">
        <a class="back-link" href="/">Back</a>
        <p class="eyebrow">Local Multiplayer</p>
        <h1>Create Or Join</h1>
        <p>Pick a saved map, create a room, then open another tab to join it. Movement is WASD and doors are pushed by walking into them.</p>
        <div class="menu-actions">
          <button class="primary-action" data-action="create">Create Game</button>
          <button class="secondary-action" data-action="join">Join Game</button>
        </div>
        <div class="room-list"></div>
        <p class="play-hud"></p>
      </section>
    `;
    document.body.appendChild(this.shell);
    this.hud = this.shell.querySelector<HTMLElement>(".play-hud") ?? undefined;
    this.shell.querySelector("[data-action='create']")?.addEventListener("click", () => void this.createGame());
    this.shell.querySelector("[data-action='join']")?.addEventListener("click", () => void this.joinGame());
    void this.refreshRooms();
  }

  private async createGame(): Promise<void> {
    const maps = await listMaps();
    const map = await pickFromList("Create Game On Map", maps.map(mapSummaryToPickable));
    if (!map) return;
    this.connect({ mode: "create", mapId: map.id, debug: true });
  }

  private async joinGame(): Promise<void> {
    const rooms = await listRooms();
    const roomItems = rooms.map((room) => roomToPickable(room));
    const picked = roomItems.length > 0 ? await pickFromList("Join Room", roomItems) : null;
    const typed = picked?.id ?? window.prompt("Room code");
    if (!typed) return;
    this.connect({ mode: "join", roomId: typed, debug: true });
  }

  private async refreshRooms(): Promise<void> {
    const container = this.shell?.querySelector<HTMLElement>(".room-list");
    if (!container) return;
    try {
      const rooms = await listRooms();
      container.innerHTML = rooms.length
        ? rooms.map((room) => `<button data-room="${room.id}">${room.id} | ${room.mapName} | ${room.playerCount}/2 | ${room.phase}</button>`).join("")
        : `<span>No active rooms yet.</span>`;
      container.querySelectorAll<HTMLButtonElement>("button[data-room]").forEach((button) => {
        button.addEventListener("click", () => this.connect({ mode: "join", roomId: button.dataset.room!, debug: true }));
      });
    } catch {
      container.innerHTML = `<span>Room list unavailable.</span>`;
    }
  }

  private connect(hello: { mode: "create" | "join"; mapId?: string; roomId?: string; debug: boolean }): void {
    this.socket?.close();
    this.socket = new WebSocket("ws://localhost:8787");
    this.socket.addEventListener("open", () => this.send({ type: "hello", ...hello }));
    this.socket.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data as string) as ServerMessage));
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === "welcome") {
      this.welcome = message;
      this.shell?.classList.add("in-game");
      drawMap(this.mapLayer!, message.map);
      this.setHud(`Room ${message.roomId} | ${message.playerId.toUpperCase()} | ${message.map.name}`);
    } else if (message.type === "snapshot") {
      this.snapshot = message;
      this.renderSnapshot(message);
    } else if (message.type === "error") {
      this.setHud(message.message);
    }
  }

  private renderSnapshot(snapshot: ServerSnapshot): void {
    if (!this.entityLayer || !this.welcome) return;
    this.mapLayer?.clear();
    drawMap(this.mapLayer!, { ...this.welcome.map, walls: snapshot.map.walls });
    this.entityLayer.clear();
    const players = snapshot.debug?.players ?? [snapshot.self, ...snapshot.visiblePlayers];
    for (const player of players) {
      drawPlayer(this.entityLayer, player.position, player.team === "blue" ? colors.blue : colors.orange, player.id === snapshot.playerId, player.aim);
    }
    const waiting = snapshot.round.phase === "lobby" || snapshot.round.phase === "countdown" ? "waiting for both players" : "active";
    this.setHud(`Room ${this.welcome.roomId} | ${snapshot.playerId.toUpperCase()} | ${this.welcome.map.name} | ${waiting}`);
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private setHud(text: string): void {
    if (this.hud) this.hud.textContent = text;
  }
}

function roomToPickable(room: RoomSummary) {
  return { id: room.id, name: `${room.id} | ${room.mapName}`, detail: `${room.playerCount}/2 ${room.phase}` };
}
