import Phaser from "phaser";
import { distance, lineIntersection, normalize, type GadgetKind, type PlayerCommand, type PlayerId, type PlayerState, type RoomSummary, type ServerMessage, type ServerSnapshot, type ServerWelcome, type ShotImpact, type Vec2, type Wall } from "@tac/shared";
import { listMaps, listRooms } from "../editorApi";
import { mapSummaryToPickable, pickFromList } from "../fuzzyPicker";
import { colors, drawDeployedCamera, drawFogOfWar, drawMap, drawMolotovZone, drawPlayer, drawSmokeZone, drawSoundSensorZone } from "../render";

const GADGET_RANGES: Record<GadgetKind, number> = { camera: 180, molotov: 220, smoke: 220, wall: 180, sound: 180 };
const GADGET_RADII: Record<Exclude<GadgetKind, "wall">, number> = { camera: 120, molotov: 55, smoke: 62, sound: 135 };
const DEPLOYABLE_WALL_LENGTH = 36;
const DEPLOYABLE_WALL_THICKNESS = 10;
const ROOM_REFRESH_MS = 5000;

interface GadgetPreviewTarget {
  position: Vec2;
  blocked: boolean;
  invalid?: boolean;
  losBlock?: Vec2;
  firstImpact?: Vec2;
  bounceStart?: Vec2;
  bounceEnd?: Vec2;
}

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
  private selectedGadget: GadgetKind | "none" = "none";
  private wallAngle = 0;
  private queuedDeploy: { gadget: GadgetKind; target: Vec2; angle?: number } | undefined = undefined;
  private pendingDeploy: { gadget: GadgetKind; seq: number } | undefined = undefined;
  private roomRefreshTimer: number | undefined = undefined;
  private roomRefreshStartedAt = 0;
  private refreshBar: HTMLElement | undefined = undefined;

  constructor() {
    super("play");
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.bg);
    this.mapLayer = this.add.graphics();
    this.entityLayer = this.add.graphics();
    this.keys = this.input.keyboard?.addKeys("W,A,S,D,R,SHIFT,ONE,TWO,THREE,FOUR,FIVE") as Record<string, Phaser.Input.Keyboard.Key>;
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.queueGadgetDeploy(pointer));
    this.input.on("wheel", (_pointer: Phaser.Input.Pointer, _objects: unknown[], _dx: number, dy: number) => {
      if (this.selectedGadget !== "wall") return;
      this.wallAngle += (dy > 0 ? 1 : -1) * (Math.PI / 12);
    });
    this.createLobby();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.stopRoomRefresh();
      this.shell?.remove();
    });
  }

  update(): void {
    if (!this.snapshot || !this.welcome || !this.keys) return;
    const pointer = this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    if (this.keys.ONE && Phaser.Input.Keyboard.JustDown(this.keys.ONE)) this.toggleGadget("camera");
    if (this.keys.TWO && Phaser.Input.Keyboard.JustDown(this.keys.TWO)) this.toggleGadget("molotov");
    if (this.keys.THREE && Phaser.Input.Keyboard.JustDown(this.keys.THREE)) this.toggleGadget("smoke");
    if (this.keys.FOUR && Phaser.Input.Keyboard.JustDown(this.keys.FOUR)) this.toggleGadget("wall");
    if (this.keys.FIVE && Phaser.Input.Keyboard.JustDown(this.keys.FIVE)) this.toggleGadget("sound");
    this.currentAim = Math.atan2(world.y - this.snapshot.self.position.y, world.x - this.snapshot.self.position.x);
    const deploy = this.queuedDeploy;
    const command: Omit<PlayerCommand, "type" | "seq" | "tick"> = {
      move: {
        x: Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown),
        y: Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown)
      },
      aim: this.currentAim,
      fire: pointer.isDown && pointer.button === 0 && this.selectedGadget === "none",
      use: "none",
      reload: this.keys.R ? Phaser.Input.Keyboard.JustDown(this.keys.R) : false,
      walk: Boolean(this.keys.SHIFT?.isDown),
      gadget: deploy ? deploy.gadget : "none",
      ...(deploy ? { gadgetTarget: deploy.target } : {}),
      ...(deploy?.angle !== undefined ? { gadgetAngle: deploy.angle } : {})
    };
    const seq = ++this.seq;
    if (this.snapshot.round.phase !== "ended") this.send({ type: "command", seq, tick: this.snapshot.tick, ...command });
    if (deploy) {
      this.pendingDeploy = { gadget: deploy.gadget, seq };
      this.queuedDeploy = undefined;
    }
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
        <div class="room-refresh" aria-hidden="true"><i></i></div>
        <div class="room-list"></div>
        <div class="play-hud"></div>
        <div class="match-actions" hidden>
          <button class="primary-action" data-action="rematch">Rematch</button>
          <button class="secondary-action" data-action="lobby">Return to Lobby</button>
        </div>
      </section>
    `;
    document.body.appendChild(this.shell);
    this.hud = this.shell.querySelector<HTMLElement>(".play-hud") ?? undefined;
    this.refreshBar = this.shell.querySelector<HTMLElement>(".room-refresh i") ?? undefined;
    this.shell.querySelector("[data-action='create']")?.addEventListener("click", () => void this.createGame());
    this.shell.querySelector("[data-action='join']")?.addEventListener("click", () => void this.joinGame());
    this.shell.querySelector("[data-action='rematch']")?.addEventListener("click", () => {
      this.rematchRequested = true;
      this.send({ type: "rematch" });
      this.setHud("Rematch requested. Waiting for the other player.");
    });
    this.shell.querySelector("[data-action='lobby']")?.addEventListener("click", () => this.returnToLobby());
    void this.refreshRooms();
    this.startRoomRefresh();
  }

  private async createGame(): Promise<void> {
    const maps = await listMaps();
    const map = await pickFromList("Create Game On Map", maps.map(mapSummaryToPickable));
    if (!map) return;
    this.connect({ mode: "create", mapId: map.id, debug: false });
  }

  private async joinGame(): Promise<void> {
    const rooms = await listRooms();
    const roomItems = rooms.map((room) => roomToPickable(room));
    const picked = roomItems.length > 0 ? await pickFromList("Join Room", roomItems) : null;
    const typed = picked?.id ?? window.prompt("Room code");
    if (!typed) return;
    this.connect({ mode: "join", roomId: typed, debug: false });
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
        button.addEventListener("click", () => this.connect({ mode: "join", roomId: button.dataset.room!, debug: false }));
      });
    } catch {
      container.innerHTML = `<span>Room list unavailable.</span>`;
    }
    this.roomRefreshStartedAt = performance.now();
    if (this.refreshBar) this.refreshBar.style.transform = "scaleX(0)";
  }

  private startRoomRefresh(): void {
    this.stopRoomRefresh();
    this.roomRefreshStartedAt = performance.now();
    this.roomRefreshTimer = window.setInterval(() => {
      const elapsed = performance.now() - this.roomRefreshStartedAt;
      const progress = Math.min(1, elapsed / ROOM_REFRESH_MS);
      if (this.refreshBar) this.refreshBar.style.transform = `scaleX(${progress})`;
      if (progress >= 1) void this.refreshRooms();
    }, 100);
  }

  private stopRoomRefresh(): void {
    if (this.roomRefreshTimer !== undefined) window.clearInterval(this.roomRefreshTimer);
    this.roomRefreshTimer = undefined;
  }

  private connect(hello: { mode: "create" | "join"; mapId?: string; roomId?: string; debug: boolean }): void {
    this.stopRoomRefresh();
    this.socket?.close();
    this.snapshot = undefined;
    this.welcome = undefined;
    this.renderedPlayers.clear();
    this.rematchRequested = false;
    this.selectedGadget = "none";
    this.queuedDeploy = undefined;
    this.pendingDeploy = undefined;
    this.socket = new WebSocket("ws://localhost:8787");
    this.socket.addEventListener("open", () => this.send({ type: "hello", ...hello }));
    this.socket.addEventListener("message", (event) => this.onMessage(JSON.parse(event.data as string) as ServerMessage));
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === "welcome") {
      this.welcome = message;
      this.shell?.classList.add("in-game");
      drawMap(this.mapLayer!, message.map);
      this.setHud(`Room ${message.roomId} | ${message.playerId.toUpperCase()} | ${message.map.name} | waiting for player`);
    } else if (message.type === "snapshot") {
      if (this.pendingDeploy) {
        const result = message.actionResults.find((candidate) => candidate.action === "gadget" && candidate.seq === this.pendingDeploy?.seq);
        if (result?.accepted) {
          this.selectedGadget = "none";
          this.pendingDeploy = undefined;
        } else if (result && !result.accepted) {
          this.pendingDeploy = undefined;
        }
      }
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
    drawFogOfWar(this.entityLayer, this.welcome.map, snapshot.visiblePolygon, snapshot.visibleCircles);
    const selfTarget = this.smoothedPlayer(snapshot.self);
    this.drawAimGuide(selfTarget.position, this.currentAim || snapshot.self.aim);
    this.drawGadgetPreview(selfTarget.position);
    for (const impact of snapshot.shotImpacts) this.drawShotImpact(impact, snapshot.tick);
    for (const camera of snapshot.gadgets.cameras) drawDeployedCamera(this.entityLayer, camera, camera.owner === snapshot.playerId);
    for (const zone of snapshot.gadgets.molotovs) drawMolotovZone(this.entityLayer, zone, snapshot.tick);
    for (const zone of snapshot.gadgets.smokes) drawSmokeZone(this.entityLayer, zone, snapshot.tick);
    for (const zone of snapshot.gadgets.soundSensors) drawSoundSensorZone(this.entityLayer, zone, snapshot.tick);
    for (const detection of snapshot.detections) {
      if (detection.kind !== "sound-area") continue;
      this.entityLayer.lineStyle(2, colors.warning, detection.confidence);
      this.entityLayer.strokeCircle(detection.position.x, detection.position.y, detection.radius ?? 80);
      this.entityLayer.fillStyle(colors.warning, 0.12);
      this.entityLayer.fillCircle(detection.position.x, detection.position.y, detection.radius ?? 80);
    }
    const players = [snapshot.self, ...snapshot.visiblePlayers];
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
    drawDottedLine(this.entityLayer, origin, end, this.selectedGadget === "none" ? colors.blue : colors.sensor, 0.3, 7, 9);
  }

  private drawGadgetPreview(origin: Vec2): void {
    if (!this.entityLayer || this.selectedGadget === "none") return;
    const pointer = this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const resolved = this.resolveGadgetTarget(origin, world, this.selectedGadget);
    const end = resolved.position;
    const color = resolved.invalid ? colors.warning : this.selectedGadget === "camera" || this.selectedGadget === "sound" ? colors.sensor : this.selectedGadget === "smoke" ? 0xb6c3cc : this.selectedGadget === "wall" ? colors.wall : colors.destructible;
    this.entityLayer.lineStyle(1, color, 0.62);
    this.entityLayer.lineBetween(origin.x, origin.y, resolved.losBlock?.x ?? end.x, resolved.losBlock?.y ?? end.y);
    if (resolved.firstImpact) {
      this.entityLayer.lineStyle(1, colors.warning, 0.7);
      this.entityLayer.lineBetween(origin.x, origin.y, resolved.firstImpact.x, resolved.firstImpact.y);
      if (resolved.bounceStart && resolved.bounceEnd) this.entityLayer.lineBetween(resolved.bounceStart.x, resolved.bounceStart.y, resolved.bounceEnd.x, resolved.bounceEnd.y);
      this.entityLayer.lineStyle(2, colors.warning, 0.86);
      this.entityLayer.strokeCircle(end.x, end.y, 10);
    }
    if (resolved.invalid && resolved.losBlock) {
      this.entityLayer.fillStyle(colors.warning, 0.85);
      this.entityLayer.fillCircle(resolved.losBlock.x, resolved.losBlock.y, 4);
    }
    if (this.selectedGadget === "wall") {
      const dx = Math.cos(this.wallAngle) * (DEPLOYABLE_WALL_LENGTH / 2);
      const dy = Math.sin(this.wallAngle) * (DEPLOYABLE_WALL_LENGTH / 2);
      this.entityLayer.lineStyle(DEPLOYABLE_WALL_THICKNESS, color, 0.78);
      this.entityLayer.lineBetween(end.x - dx, end.y - dy, end.x + dx, end.y + dy);
      this.entityLayer.lineStyle(1, colors.destructible, 0.8);
      this.entityLayer.strokeCircle(end.x, end.y, 12);
      return;
    }
    const radius = GADGET_RADII[this.selectedGadget];
    this.entityLayer.strokeCircle(end.x, end.y, radius);
    this.entityLayer.fillStyle(color, 0.16);
    this.entityLayer.fillCircle(end.x, end.y, radius);
  }

  private resolveGadgetTarget(origin: Vec2, target: Vec2, gadget: GadgetKind): GadgetPreviewTarget {
    const position = this.clampedGadgetTarget(origin, target, gadget);
    if (!this.snapshot) return { position, blocked: false };
    if (gadget !== "molotov" && gadget !== "smoke") return withPlacementValidity(this.snapshot.map.walls, origin, { position, blocked: false });
    const hit = firstThrowHit(this.snapshot.map.walls, origin, position);
    if (!hit) return withPlacementValidity(this.snapshot.map.walls, origin, { position, blocked: false });
    const direction = normalize({ x: position.x - origin.x, y: position.y - origin.y });
    const reflected = reflect(direction, hit.wall);
    const remaining = Math.max(0, distance(origin, position) - hit.distance);
    const bounceStart = { x: hit.point.x + reflected.x * Math.max(10, hit.wall.thickness / 2 + 2), y: hit.point.y + reflected.y * Math.max(10, hit.wall.thickness / 2 + 2) };
    const bounceTarget = this.clampedGadgetTarget(bounceStart, { x: bounceStart.x + reflected.x * remaining, y: bounceStart.y + reflected.y * remaining }, gadget);
    const secondHit = firstThrowHit(this.snapshot.map.walls, bounceStart, bounceTarget, hit.wall.id);
    const finalPosition = secondHit
      ? this.clampedGadgetTarget(origin, { x: secondHit.point.x - reflected.x * Math.max(10, secondHit.wall.thickness / 2 + 2), y: secondHit.point.y - reflected.y * Math.max(10, secondHit.wall.thickness / 2 + 2) }, gadget)
      : bounceTarget;
    return withPlacementValidity(this.snapshot.map.walls, origin, { position: finalPosition, blocked: true, firstImpact: hit.point, bounceStart, bounceEnd: finalPosition });
  }

  private clampedGadgetTarget(origin: Vec2, target: Vec2, gadget: GadgetKind): Vec2 {
    const range = GADGET_RANGES[gadget];
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0.0001) return { ...origin };
    const direction = { x: dx / length, y: dy / length };
    const scaleDistance = Math.min(length, range, this.boundsDistance(origin, direction));
    const x = origin.x + direction.x * scaleDistance;
    const y = origin.y + direction.y * scaleDistance;
    const bounds = this.welcome?.map.bounds;
    return bounds ? { x: Phaser.Math.Clamp(x, 10, bounds.width - 10), y: Phaser.Math.Clamp(y, 10, bounds.height - 10) } : { x, y };
  }

  private boundsDistance(origin: Vec2, direction: Vec2): number {
    const bounds = this.welcome?.map.bounds;
    if (!bounds) return Number.POSITIVE_INFINITY;
    let limit = Number.POSITIVE_INFINITY;
    if (direction.x > 0) limit = Math.min(limit, (bounds.width - 10 - origin.x) / direction.x);
    if (direction.x < 0) limit = Math.min(limit, (10 - origin.x) / direction.x);
    if (direction.y > 0) limit = Math.min(limit, (bounds.height - 10 - origin.y) / direction.y);
    if (direction.y < 0) limit = Math.min(limit, (10 - origin.y) / direction.y);
    return Number.isFinite(limit) ? Math.max(0, limit) : 0;
  }

  private queueGadgetDeploy(pointer: Phaser.Input.Pointer): void {
    if (!this.snapshot || this.selectedGadget === "none" || this.pendingDeploy || pointer.button !== 0) return;
    const target = pointer.event?.target as HTMLElement | null;
    if (target?.closest?.(".play-panel")) return;
    const available = this.snapshot.self.gadgets[this.selectedGadget] ?? 0;
    if (available <= 0) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const resolved = this.resolveGadgetTarget(this.snapshot.self.position, world, this.selectedGadget);
    if (resolved.invalid) return;
    const deployTarget = resolved.position;
    this.queuedDeploy = {
      gadget: this.selectedGadget,
      target: deployTarget,
      ...(this.selectedGadget === "wall" ? { angle: this.wallAngle } : {})
    };
  }

  private toggleGadget(gadget: GadgetKind): void {
    this.selectedGadget = this.selectedGadget === gadget ? "none" : gadget;
    this.pendingDeploy = undefined;
    if (this.selectedGadget === "wall") this.wallAngle = this.currentAim;
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
    const time = round.phase === "lobby" ? "waiting for player" : round.phase === "active" ? formatTime(countdown) : round.phase === "countdown" ? `starts in ${countdown}` : "ended";
    const roundResult = round.winner ? ` | round ${round.winner === "draw" ? "draw" : `${round.winner.toUpperCase()} won`}` : "";
    const score = `${round.scores.p1}-${round.scores.p2}`;
    if (round.matchWinner) {
      const result = round.matchWinner === snapshot.playerId ? "Victory" : "Defeat";
      this.setHud(`${result} | Final ${score} | ${this.welcome.map.name}${this.rematchRequested ? " | rematch requested" : ""}`);
      this.shell?.querySelector<HTMLElement>(".match-actions")?.removeAttribute("hidden");
      return;
    }
    this.shell?.querySelector<HTMLElement>(".match-actions")?.setAttribute("hidden", "true");
    this.setHudHtml(`
      <div class="hud-topline">
        <span>R${round.roundNumber}</span>
        <strong>${time}</strong>
        <span>${score}</span>
      </div>
      <div class="hud-bars">
        <label>HP <span>${snapshot.self.hp}/5</span></label>
        <div class="health-track"><i style="width:${Math.max(0, Math.min(100, (snapshot.self.hp / 5) * 100))}%"></i></div>
      </div>
      <div class="hud-loadout">
        <span class="${snapshot.self.isReloading ? "warn" : ""}">${snapshot.self.isReloading ? "RELOADING" : `AMMO ${snapshot.self.ammo}/${snapshot.self.magSize}`}</span>
        <button class="${this.selectedGadget === "camera" ? "selected" : ""}" data-gadget="camera">CAM ${snapshot.self.gadgets.camera}</button>
        <button class="${this.selectedGadget === "molotov" ? "selected" : ""}" data-gadget="molotov">MOL ${snapshot.self.gadgets.molotov}</button>
        <button class="${this.selectedGadget === "smoke" ? "selected" : ""}" data-gadget="smoke">SMK ${snapshot.self.gadgets.smoke}</button>
        <button class="${this.selectedGadget === "wall" ? "selected" : ""}" data-gadget="wall">WALL ${snapshot.self.gadgets.wall}</button>
        <button class="${this.selectedGadget === "sound" ? "selected" : ""}" data-gadget="sound">SND ${snapshot.self.gadgets.sound}</button>
      </div>
      <div class="hud-meta">${this.welcome.roomId} | ${snapshot.playerId.toUpperCase()} | ${this.welcome.map.name}${roundResult}</div>
    `);
    this.hud?.querySelectorAll<HTMLButtonElement>("[data-gadget]").forEach((button) => {
      button.addEventListener("click", () => this.toggleGadget(button.dataset.gadget as GadgetKind));
    });
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

  private setHudHtml(html: string): void {
    if (this.hud) this.hud.innerHTML = html;
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

function firstThrowHit(walls: Wall[], origin: Vec2, target: Vec2, ignoreWallId?: string): { wall: Wall; point: Vec2; distance: number } | null {
  let nearest: { wall: Wall; point: Vec2; distance: number } | null = null;
  let nearestDistance = distance(origin, target);
  for (const wall of walls) {
    if (wall.id === ignoreWallId || wall.destroyed || !throwBlockingWall(wall)) continue;
    const hit = lineIntersection(origin, target, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (hitDistance < nearestDistance) {
      nearest = { wall, point: hit, distance: hitDistance };
      nearestDistance = hitDistance;
    }
  }
  return nearest;
}

function throwBlockingWall(wall: Wall): boolean {
  return wall.kind === "door" || wall.kind === "solid" || wall.blocksVision;
}

function withPlacementValidity(walls: Wall[], origin: Vec2, target: GadgetPreviewTarget): GadgetPreviewTarget {
  const losBlock = firstPlacementBlock(walls, origin, target.position);
  return losBlock ? { ...target, invalid: true, losBlock } : target;
}

function firstPlacementBlock(walls: Wall[], origin: Vec2, target: Vec2): Vec2 | undefined {
  let nearest: Vec2 | undefined;
  let nearestDistance = distance(origin, target);
  for (const wall of walls) {
    if (wall.destroyed || !placementBlockingWall(wall)) continue;
    const hit = lineIntersection(origin, target, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (hitDistance < nearestDistance) {
      nearest = hit;
      nearestDistance = hitDistance;
    }
  }
  return nearest;
}

function placementBlockingWall(wall: Wall): boolean {
  if (wall.kind === "mesh") return false;
  return wall.kind === "door" || wall.kind === "transparent" || wall.blocksVision || wall.kind === "solid";
}

function reflect(direction: Vec2, wall: Wall): Vec2 {
  const wallDirection = normalize({ x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y });
  const normal = { x: -wallDirection.y, y: wallDirection.x };
  const dot = direction.x * normal.x + direction.y * normal.y;
  return normalize({ x: direction.x - 2 * dot * normal.x, y: direction.y - 2 * dot * normal.y });
}
