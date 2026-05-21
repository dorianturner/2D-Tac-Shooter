import Phaser from "phaser";
import type { PlayerCommand, PlayerId, PlayerState, RoomSummary, ServerMessage, ServerSnapshot, ServerWelcome, ShotImpact, Vec2 } from "@tac/shared";
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
  private renderedPlayers = new Map<PlayerId, { position: Vec2; aim: number }>();
  private currentAim = 0;
  private rematchRequested = false;

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
    this.currentAim = Math.atan2(world.y - this.snapshot.self.position.y, world.x - this.snapshot.self.position.x);
    const command: Omit<PlayerCommand, "type" | "seq" | "tick"> = {
      move: {
        x: Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown),
        y: Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown)
      },
      aim: this.currentAim,
      fire: pointer.isDown && pointer.button === 0,
      use: "none"
    };
    if (this.snapshot.round.phase !== "ended") this.send({ type: "command", seq: ++this.seq, tick: this.snapshot.tick, ...command });
    this.renderSnapshot(this.snapshot);
    const renderedSelf = this.renderedPlayers.get(this.snapshot.playerId);
    if (renderedSelf) this.cameras.main.centerOn(renderedSelf.position.x, renderedSelf.position.y);
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
        <div class="match-actions" hidden>
          <button class="primary-action" data-action="rematch">Rematch</button>
          <button class="secondary-action" data-action="lobby">Return to Lobby</button>
        </div>
      </section>
    `;
    document.body.appendChild(this.shell);
    this.hud = this.shell.querySelector<HTMLElement>(".play-hud") ?? undefined;
    this.shell.querySelector("[data-action='create']")?.addEventListener("click", () => void this.createGame());
    this.shell.querySelector("[data-action='join']")?.addEventListener("click", () => void this.joinGame());
    this.shell.querySelector("[data-action='rematch']")?.addEventListener("click", () => {
      this.rematchRequested = true;
      this.send({ type: "rematch" });
      this.setHud("Rematch requested. Waiting for the other player.");
    });
    this.shell.querySelector("[data-action='lobby']")?.addEventListener("click", () => this.returnToLobby());
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
    this.snapshot = undefined;
    this.welcome = undefined;
    this.renderedPlayers.clear();
    this.rematchRequested = false;
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
      this.mapLayer?.clear();
      drawMap(this.mapLayer!, { ...this.welcome!.map, walls: message.map.walls });
      this.renderSnapshot(message);
    } else if (message.type === "error") {
      this.setHud(message.message);
    }
  }

  private renderSnapshot(snapshot: ServerSnapshot): void {
    if (!this.entityLayer || !this.welcome) return;
    this.entityLayer.clear();
    const selfTarget = this.smoothedPlayer(snapshot.self);
    this.drawAimGuide(selfTarget.position, this.currentAim || snapshot.self.aim);
    for (const impact of snapshot.shotImpacts) this.drawShotImpact(impact, snapshot.tick);
    const players = snapshot.debug?.players ?? [snapshot.self, ...snapshot.visiblePlayers];
    for (const player of players) {
      const rendered = this.smoothedPlayer(player);
      drawPlayer(this.entityLayer, rendered.position, player.team === "blue" ? colors.blue : colors.orange, player.id === snapshot.playerId, rendered.aim);
    }
    this.updateMatchHud(snapshot);
  }

  private smoothedPlayer(player: PlayerState): { position: Vec2; aim: number } {
    const existing = this.renderedPlayers.get(player.id);
    if (!existing) {
      const created = { position: { ...player.position }, aim: player.aim };
      this.renderedPlayers.set(player.id, created);
      return created;
    }
    const blend = player.id === this.snapshot?.playerId ? 0.58 : 0.32;
    existing.position = {
      x: Phaser.Math.Linear(existing.position.x, player.position.x, blend),
      y: Phaser.Math.Linear(existing.position.y, player.position.y, blend)
    };
    existing.aim = Phaser.Math.Angle.RotateTo(existing.aim, player.aim, 0.35);
    return existing;
  }

  private drawAimGuide(origin: Vec2, aim: number): void {
    if (!this.entityLayer) return;
    const end = { x: origin.x + Math.cos(aim) * 520, y: origin.y + Math.sin(aim) * 520 };
    drawDottedLine(this.entityLayer, origin, end, colors.blue, 0.3, 7, 9);
  }

  private drawShotImpact(impact: ShotImpact, tick: number): void {
    if (!this.entityLayer) return;
    const alpha = Math.max(0.15, 0.9 - (tick - impact.tick) * 0.14);
    drawDottedLine(this.entityLayer, impact.origin, impact.end, impact.hit === "player" ? colors.warning : colors.destructible, alpha, 11, 5);
    this.entityLayer.fillStyle(impact.hit === "player" ? colors.warning : colors.destructible, alpha);
    this.entityLayer.fillCircle(impact.end.x, impact.end.y, impact.hit === "none" ? 2 : 4);
  }

  private updateMatchHud(snapshot: ServerSnapshot): void {
    if (!this.welcome) return;
    const round = snapshot.round;
    const countdown = Math.max(0, Math.ceil(((round.phase === "countdown" ? round.startsAtTick : round.endsAtTick) - snapshot.tick) / 30));
    const time = round.phase === "active" ? formatTime(countdown) : round.phase === "countdown" ? `starts in ${countdown}` : "ended";
    const roundResult = round.winner ? ` | round ${round.winner === "draw" ? "draw" : `${round.winner.toUpperCase()} won`}` : "";
    const hp = `HP ${snapshot.self.hp}/5`;
    const score = `${round.scores.p1}-${round.scores.p2}`;
    if (round.matchWinner) {
      const result = round.matchWinner === snapshot.playerId ? "Victory" : "Defeat";
      this.setHud(`${result} | Final ${score} | ${this.welcome.map.name}${this.rematchRequested ? " | rematch requested" : ""}`);
      this.shell?.querySelector<HTMLElement>(".match-actions")?.removeAttribute("hidden");
      return;
    }
    this.shell?.querySelector<HTMLElement>(".match-actions")?.setAttribute("hidden", "true");
    this.setHud(`Room ${this.welcome.roomId} | ${snapshot.playerId.toUpperCase()} | ${this.welcome.map.name} | R${round.roundNumber} ${score} | ${time} | ${hp}${roundResult}`);
  }

  private returnToLobby(): void {
    this.socket?.close();
    this.socket = undefined;
    this.scene.restart();
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

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function drawDottedLine(g: Phaser.GameObjects.Graphics, from: Vec2, to: Vec2, color: number, alpha: number, dash: number, gap: number): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length <= 0) return;
  const ux = dx / length;
  const uy = dy / length;
  g.lineStyle(1, color, alpha);
  for (let offset = 0; offset < length; offset += dash + gap) {
    const end = Math.min(length, offset + dash);
    g.lineBetween(from.x + ux * offset, from.y + uy * offset, from.x + ux * end, from.y + uy * end);
  }
}
