import Phaser from "phaser";
import { distance, isHingedDoorSegment, lineIntersection, normalize, playerClassPresets, weaponPresets, type GadgetKind, type PlayerClassPresetId, type PlayerCommand, type PlayerId, type PlayerLoadoutSelection, type PlayerState, type RoomSummary, type ServerMessage, type ServerSnapshot, type ServerWelcome, type ShotImpact, type Vec2, type Wall, type WeaponPresetId, TICK_RATE } from "@tac/shared";
import { listMaps, listRooms } from "../editorApi";
import { mapSummaryToPickable, pickFromList } from "../fuzzyPicker";
import { colors, drawDeployedCamera, drawFogOfWar, drawMap, drawMolotovZone, drawObjective, drawPlayer, drawSmokeZone, drawSoundSensorZone } from "../render";
import { websocketUrl } from "../serverConfig";
import { AudioDirector } from "../audioDirector";
import { muzzleWorldPoint, PlaySpritePresenter, playImpactSprite, playMuzzleFlashSprite } from "../playSprites";

const GADGET_RANGES: Record<GadgetKind, number> = { camera: 180, molotov: 220, smoke: 220, wall: 180, sound: 180 };
const GADGET_RADII: Record<Exclude<GadgetKind, "wall">, number> = { camera: 120, molotov: 55, smoke: 62, sound: 135 };
const DEPLOYABLE_WALL_LENGTH = 36;
const DEPLOYABLE_WALL_THICKNESS = 10;
const ROOM_REFRESH_MS = 2000;
const SERVER_TICK_MS = 1000 / TICK_RATE;
const PLAY_CAMERA_ZOOM = 1.15;

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
  private sprites: PlaySpritePresenter | undefined = undefined;
  private shell: HTMLElement | undefined = undefined;
  private hud: HTMLElement | undefined = undefined;
  private keys: Record<string, Phaser.Input.Keyboard.Key> | undefined = undefined;
  private renderedPlayers = new Map<PlayerId, { position: Vec2; aim: number }>();
  private renderedWalls = new Map<string, Wall>();
  private lastSnapshotAtMs = 0;
  private currentAim = 0;
  private rematchRequested = false;
  private selectedGadget: GadgetKind | "none" = "none";
  private wallAngle = 0;
  private menuOpen = false;
  private queuedDeploy: { gadget: GadgetKind; target: Vec2; angle?: number } | undefined = undefined;
  private pendingDeploy: { gadget: GadgetKind; seq: number } | undefined = undefined;
  private roomRefreshTimer: number | undefined = undefined;
  private roomRefreshStartedAt = 0;
  private refreshBar: HTMLElement | undefined = undefined;
  private selectedClass: PlayerClassPresetId = "operator";
  private selectedWeapon: WeaponPresetId = "assault";
  private audio = new AudioDirector();
  private playedShotFx = new Set<string>();
  private playedShotFxOrder: string[] = [];

  constructor() {
    super("play");
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.bg);
    this.cameras.main.setZoom(PLAY_CAMERA_ZOOM);
    this.mapLayer = this.add.graphics();
    this.entityLayer = this.add.graphics();
    this.mapLayer.setDepth(0);
    this.entityLayer.setDepth(30);
    this.sprites = new PlaySpritePresenter(this);
    this.keys = this.input.keyboard?.addKeys("W,A,S,D,E,Q,R,ESC,SHIFT,ONE,TWO,THREE,FOUR,FIVE") as Record<string, Phaser.Input.Keyboard.Key>;
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => {
      void this.audio.unlock();
      this.queueGadgetDeploy(pointer);
    });
    this.input.keyboard?.on("keydown", () => void this.audio.unlock());
    this.input.on("wheel", (_pointer: Phaser.Input.Pointer, _objects: unknown[], _dx: number, dy: number) => {
      if (this.selectedGadget !== "wall") return;
      this.wallAngle += (dy > 0 ? 1 : -1) * (Math.PI / 12);
    });
    this.createLobby();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.stopRoomRefresh();
      this.audio.dispose();
      this.sprites?.clear();
      this.clearPlayedShotFx();
      this.shell?.remove();
    });
  }

  update(): void {
    if (!this.snapshot || !this.welcome || !this.keys) return;
    const pointer = this.input.activePointer;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    if (this.keys.ESC && Phaser.Input.Keyboard.JustDown(this.keys.ESC)) this.toggleMenu();
    if (!this.menuOpen && this.keys.ONE && Phaser.Input.Keyboard.JustDown(this.keys.ONE)) this.toggleGadget("camera");
    if (!this.menuOpen && this.keys.TWO && Phaser.Input.Keyboard.JustDown(this.keys.TWO)) this.toggleGadget("molotov");
    if (!this.menuOpen && this.keys.THREE && Phaser.Input.Keyboard.JustDown(this.keys.THREE)) this.toggleGadget("smoke");
    if (!this.menuOpen && this.keys.FOUR && Phaser.Input.Keyboard.JustDown(this.keys.FOUR)) this.toggleGadget("wall");
    if (!this.menuOpen && this.keys.FIVE && Phaser.Input.Keyboard.JustDown(this.keys.FIVE)) this.toggleGadget("sound");
    this.currentAim = Math.atan2(world.y - this.snapshot.self.position.y, world.x - this.snapshot.self.position.x);
    const deploy = this.menuOpen ? undefined : this.queuedDeploy;
    const command: Omit<PlayerCommand, "type" | "seq" | "tick"> = {
      move: {
        x: this.menuOpen ? 0 : Number(this.keys.D?.isDown) - Number(this.keys.A?.isDown),
        y: this.menuOpen ? 0 : Number(this.keys.S?.isDown) - Number(this.keys.W?.isDown)
      },
      aim: this.currentAim,
      fire: !this.menuOpen && pointer.isDown && pointer.button === 0 && this.selectedGadget === "none",
      use: !this.menuOpen && this.keys.E && Phaser.Input.Keyboard.JustDown(this.keys.E) ? "door-toggle" : "none",
      ability: !this.menuOpen && this.keys.Q ? Phaser.Input.Keyboard.JustDown(this.keys.Q) : false,
      reload: !this.menuOpen && this.keys.R ? Phaser.Input.Keyboard.JustDown(this.keys.R) : false,
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
    this.renderMap(this.snapshot);
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
        <p>Pick a saved map, create a room, then open another tab to join it. Movement is WASD; Q uses your operator ability; doors can be pushed or toggled with E.</p>
        <div class="loadout-picker" data-loadout-picker>
          <div class="loadout-heading">
            <strong data-loadout-title>Starting Loadout</strong>
            <span data-loadout-mode>used when creating or joining</span>
          </div>
          <label>Class
            <select data-loadout="class">
              ${Object.values(playerClassPresets).map((preset) => `<option value="${preset.id}">${preset.name}</option>`).join("")}
            </select>
          </label>
          <label>Gun
            <select data-loadout="weapon">
              ${Object.values(weaponPresets).map((weapon) => `<option value="${weapon.id}">${weapon.name}</option>`).join("")}
            </select>
          </label>
          <div class="loadout-note" data-loadout-note>${formatLoadout(this.currentLoadout())}</div>
          <div class="loadout-details" data-loadout-details></div>
        </div>
        <div class="menu-actions">
          <button class="primary-action" data-action="create">Create Game</button>
          <button class="secondary-action" data-action="join">Join Game</button>
        </div>
        <div class="room-header">
          <div class="room-refresh" aria-hidden="true"><i></i></div>
          <button class="secondary-action" data-action="refresh" style="white-space: nowrap;">Refresh</button>
        </div>
        <div class="room-list"></div>
        <div class="play-hud"></div>
        <div class="escape-menu" hidden>
          <h2>Game Menu</h2>
          <p>Change loadout for next round or leave the current game.</p>
          <div class="menu-actions">
            <button class="secondary-action" data-action="resume">Resume</button>
            <button class="secondary-action" data-action="leave">Leave Game</button>
          </div>
        </div>
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
    this.shell.querySelector("[data-action='refresh']")?.addEventListener("click", () => void this.refreshRooms());
    this.shell.querySelector("[data-action='rematch']")?.addEventListener("click", () => {
      this.rematchRequested = true;
      this.send({ type: "rematch" });
      this.setHud("Rematch requested. Waiting for the other player.");
    });
    this.shell.querySelector("[data-action='lobby']")?.addEventListener("click", () => this.returnToLobby());
    this.shell.querySelector("[data-action='resume']")?.addEventListener("click", () => this.closeMenu());
    this.shell.querySelector("[data-action='leave']")?.addEventListener("click", () => this.returnToLobby());
    this.shell.querySelector<HTMLSelectElement>("[data-loadout='class']")?.addEventListener("change", (event) => {
      this.selectedClass = (event.currentTarget as HTMLSelectElement).value as PlayerClassPresetId;
      this.handleLoadoutChange();
    });
    this.shell.querySelector<HTMLSelectElement>("[data-loadout='weapon']")?.addEventListener("change", (event) => {
      this.selectedWeapon = (event.currentTarget as HTMLSelectElement).value as WeaponPresetId;
      this.handleLoadoutChange();
    });
    this.updateLoadoutStatus();
    void this.refreshRooms();
    this.startRoomRefresh();
  }

  private async createGame(): Promise<void> {
    const maps = await listMaps();
    const map = await pickFromList("Create Game On Map", maps.map(mapSummaryToPickable));
    if (!map) return;
    this.connect({ mode: "create", mapId: map.id, debug: false, loadout: this.currentLoadout() });
  }

  private async joinGame(): Promise<void> {
    const rooms = await listRooms();
    const roomItems = rooms.map((room) => roomToPickable(room));
    const picked = roomItems.length > 0 ? await pickFromList("Join Room", roomItems) : null;
    const typed = picked?.id ?? window.prompt("Room code");
    if (!typed) return;
    this.connect({ mode: "join", roomId: typed, debug: false, loadout: this.currentLoadout() });
  }

  private async refreshRooms(): Promise<void> {
    const container = this.shell?.querySelector<HTMLElement>(".room-list");
    if (!container) return;
    try {
      const rooms = await listRooms();
      container.innerHTML = rooms.length
        ? rooms.map((room) => `<button data-room="${room.id}">${room.id} | ${room.mapName} | ${room.playerCount}/${room.maxPlayers} | ${room.phase}</button>`).join("")
        : `<span>No active rooms yet.</span>`;
      container.querySelectorAll<HTMLButtonElement>("button[data-room]").forEach((button) => {
        button.addEventListener("click", () => this.connect({ mode: "join", roomId: button.dataset.room!, debug: false, loadout: this.currentLoadout() }));
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

  private connect(hello: { mode: "create" | "join"; mapId?: string; roomId?: string; debug: boolean; loadout?: PlayerLoadoutSelection }): void {
    this.stopRoomRefresh();
    this.socket?.close();
    this.snapshot = undefined;
    this.welcome = undefined;
    this.renderedPlayers.clear();
    this.sprites?.clear();
    this.clearPlayedShotFx();
    this.rematchRequested = false;
    this.selectedGadget = "none";
    this.menuOpen = false;
    this.queuedDeploy = undefined;
    this.pendingDeploy = undefined;
    this.socket = new WebSocket(websocketUrl());
    this.socket.addEventListener("open", () => this.send({ type: "hello", ...hello }));
    this.socket.addEventListener("message", (event) => {
      const message = parseServerMessage(event.data);
      if (!message) {
        this.setHud("Received a non-game WebSocket message. Check the server URL.");
        return;
      }
      this.onMessage(message);
    });
    this.socket.addEventListener("error", () => this.setHud(`Unable to connect to game server at ${websocketUrl()}.`));
  }

  private currentLoadout(): PlayerLoadoutSelection {
    return { classId: this.selectedClass, weaponId: this.selectedWeapon };
  }

  private handleLoadoutChange(): void {
    this.updateLoadoutStatus(this.snapshot);
    if (this.socket?.readyState === WebSocket.OPEN && this.welcome) {
      this.send({ type: "loadout", loadout: this.currentLoadout() });
    }
  }

  private onMessage(message: ServerMessage): void {
    if (message.type === "welcome") {
      this.welcome = message;
      this.renderedWalls.clear();
      this.sprites?.clear();
      this.clearPlayedShotFx();
      this.shell?.classList.add("in-game");
      this.updateMenuOpenClass();
      const roomHeader = this.shell?.querySelector<HTMLElement>(".room-header");
      if (roomHeader) roomHeader.style.display = "none";
      drawMap(this.mapLayer!, message.map);
      this.updateLoadoutStatus();
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
      this.lastSnapshotAtMs = performance.now();
      this.audio.playEvents(message.audibleEvents, message.self.position, message.playerId);
      this.updateLoadoutStatus(message);
      this.renderMap(message);
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
    for (const impact of snapshot.shotImpacts) this.drawShotImpact(impact, snapshot);
    for (const camera of snapshot.gadgets.cameras) drawDeployedCamera(this.entityLayer, camera, camera.owner === snapshot.playerId);
    for (const zone of snapshot.gadgets.molotovs) drawMolotovZone(this.entityLayer, zone, snapshot.tick);
    for (const zone of snapshot.gadgets.smokes) drawSmokeZone(this.entityLayer, zone, snapshot.tick);
    for (const zone of snapshot.gadgets.soundSensors) drawSoundSensorZone(this.entityLayer, zone, snapshot.tick);
    if (snapshot.round.objective) {
      drawObjective(this.entityLayer, snapshot.round.objective.position, snapshot.round.objective.radius, snapshot.round.objective.progressTicks / snapshot.round.objective.requiredTicks);
    }
    for (const detection of snapshot.detections) {
      if (detection.kind === "sound-area") {
        this.entityLayer.lineStyle(2, colors.warning, detection.confidence);
        this.entityLayer.strokeCircle(detection.position.x, detection.position.y, detection.radius ?? 80);
        this.entityLayer.fillStyle(colors.warning, 0.12);
        this.entityLayer.fillCircle(detection.position.x, detection.position.y, detection.radius ?? 80);
      }
      if (detection.kind === "tactical-ping") {
        this.entityLayer.lineStyle(2, colors.sensor, detection.confidence);
        this.entityLayer.strokeCircle(detection.position.x, detection.position.y, detection.radius ?? 28);
        this.entityLayer.fillStyle(colors.sensor, 0.18);
        this.entityLayer.fillCircle(detection.position.x, detection.position.y, 7);
      }
    }
    const players = [snapshot.self, ...snapshot.visiblePlayers];
    for (const player of players) {
      const rendered = this.smoothedPlayer(player);
      if (!this.sprites) drawPlayer(this.entityLayer, rendered.position, player.team === "blue" ? colors.blue : colors.orange, player.id === snapshot.playerId, rendered.aim);
    }
    this.sprites?.render(snapshot, this.renderedPlayers);
    this.updateMatchHud(snapshot);
  }

  private renderMap(snapshot: ServerSnapshot): void {
    if (!this.mapLayer || !this.welcome) return;
    const walls = this.smoothedWalls(snapshot.map.walls);
    drawMap(this.mapLayer, { ...this.welcome.map, walls });
  }

  private smoothedWalls(walls: Wall[]): Wall[] {
    const liveIds = new Set(walls.map((wall) => wall.id));
    for (const id of this.renderedWalls.keys()) {
      if (!liveIds.has(id)) this.renderedWalls.delete(id);
    }
    return walls.map((wall) => {
      if (!isHingedDoorSegment(wall) || wall.destroyed) {
        this.renderedWalls.set(wall.id, structuredClone(wall));
        return wall;
      }
      const predicted = this.predictedDoor(wall);
      const existing = this.renderedWalls.get(wall.id);
      if (!existing || existing.destroyed) {
        const created = structuredClone(predicted);
        this.renderedWalls.set(wall.id, created);
        return created;
      }
      const blend = 0.45;
      const smoothed: Wall = {
        ...predicted,
        a: { x: Phaser.Math.Linear(existing.a.x, predicted.a.x, blend), y: Phaser.Math.Linear(existing.a.y, predicted.a.y, blend) },
        b: { x: Phaser.Math.Linear(existing.b.x, predicted.b.x, blend), y: Phaser.Math.Linear(existing.b.y, predicted.b.y, blend) }
      };
      if (predicted.currentAngle !== undefined) smoothed.currentAngle = Phaser.Math.Linear(existing.currentAngle ?? predicted.currentAngle, predicted.currentAngle, blend);
      this.renderedWalls.set(wall.id, structuredClone(smoothed));
      return smoothed;
    });
  }

  private predictedDoor(wall: Wall): Wall {
    if (!wall.hinge || !wall.closedB || wall.currentAngle === undefined || wall.angularVelocity === undefined) return wall;
    const elapsedTicks = Phaser.Math.Clamp((performance.now() - this.lastSnapshotAtMs) / SERVER_TICK_MS, 0, 2.5);
    const angle = Phaser.Math.Clamp(wall.currentAngle + wall.angularVelocity * elapsedTicks, -1.92, 1.92);
    return { ...wall, currentAngle: angle, a: { ...wall.hinge }, b: rotateDoorEndpoint(wall.hinge, wall.closedB, angle) };
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
    const weaponRange = this.snapshot ? weaponPresets[this.snapshot.self.weaponId].effectiveRange : 520;
    const range = Number.isFinite(weaponRange) ? weaponRange : this.mapPreviewRange();
    const end = { x: origin.x + Math.cos(aim) * range, y: origin.y + Math.sin(aim) * range };
    drawDottedLine(this.entityLayer, origin, end, this.selectedGadget === "none" ? colors.blue : colors.sensor, 0.3, 7, 9);
  }

  private mapPreviewRange(): number {
    const bounds = this.welcome?.map.bounds;
    return bounds ? Math.hypot(bounds.width, bounds.height) * 2 : 1200;
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
    if (this.menuOpen) return;
    this.selectedGadget = this.selectedGadget === gadget ? "none" : gadget;
    this.pendingDeploy = undefined;
    if (this.selectedGadget === "wall") this.wallAngle = this.currentAim;
  }

  private toggleMenu(): void {
    this.menuOpen = !this.menuOpen;
    if (this.menuOpen) {
      this.selectedGadget = "none";
      this.queuedDeploy = undefined;
      this.pendingDeploy = undefined;
    }
    this.updateMenuOpenClass();
    this.updateLoadoutStatus(this.snapshot);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.updateMenuOpenClass();
  }

  private drawShotImpact(impact: ShotImpact, snapshot: ServerSnapshot): void {
    if (!this.entityLayer) return;
    const tick = snapshot.tick;
    const alpha = Math.max(0.15, 0.9 - (tick - impact.tick) * 0.14);
    const origin = this.visualShotOrigin(impact, snapshot);
    drawDottedLine(this.entityLayer, origin, impact.end, impact.hit === "player" ? colors.warning : colors.destructible, alpha, 11, 5);
    this.entityLayer.fillStyle(impact.hit === "player" ? colors.warning : colors.destructible, alpha);
    this.entityLayer.fillCircle(impact.end.x, impact.end.y, impact.hit === "none" ? 2 : 4);
    if (tick === impact.tick && this.claimShotFx(impact.id)) {
      playMuzzleFlashSprite(this, origin, Math.atan2(impact.end.y - origin.y, impact.end.x - origin.x));
      if (impact.hit !== "none") playImpactSprite(this, impact.end);
    }
  }

  private visualShotOrigin(impact: ShotImpact, snapshot: ServerSnapshot): Vec2 {
    const shooter = impact.shooter === snapshot.self.id ? snapshot.self : snapshot.visiblePlayers.find((player) => player.id === impact.shooter);
    if (!shooter) {
      const aim = Math.atan2(impact.end.y - impact.origin.y, impact.end.x - impact.origin.x);
      return { x: impact.origin.x + Math.cos(aim) * 28, y: impact.origin.y + Math.sin(aim) * 28 };
    }
    const rendered = this.renderedPlayers.get(shooter.id);
    const position = rendered?.position ?? shooter.position;
    const aim = rendered?.aim ?? shooter.aim;
    return muzzleWorldPoint(position, aim, shooter.weaponId);
  }

  private claimShotFx(id: string): boolean {
    if (this.playedShotFx.has(id)) return false;
    this.playedShotFx.add(id);
    this.playedShotFxOrder.push(id);
    while (this.playedShotFxOrder.length > 240) {
      const stale = this.playedShotFxOrder.shift();
      if (stale) this.playedShotFx.delete(stale);
    }
    return true;
  }

  private clearPlayedShotFx(): void {
    this.playedShotFx.clear();
    this.playedShotFxOrder = [];
  }

  private updateMatchHud(snapshot: ServerSnapshot): void {
    if (!this.welcome) return;
    const round = snapshot.round;
    const countdownTarget = round.phase === "countdown" ? round.startsAtTick : round.phase === "overtime" ? round.overtimeEndsAtTick ?? round.endsAtTick : round.endsAtTick;
    const countdown = Math.max(0, Math.ceil((countdownTarget - snapshot.tick) / TICK_RATE));
    const time = round.phase === "lobby" ? "waiting for player" : round.phase === "active" ? formatTime(countdown) : round.phase === "overtime" ? `OT ${formatTime(countdown)}` : round.phase === "countdown" ? `starts in ${countdown}` : "ended";
    const roundResult = round.winner ? ` | round ${round.winner === "draw" ? "draw" : `${round.winner.toUpperCase()} won`}` : "";
    const score = Object.entries(round.scores).map(([id, value]) => `${id.toUpperCase()} ${value}`).join(" / ");
    const doorDebug = snapshot.debug
      ? snapshot.map.walls
        .filter((wall) => isHingedDoorSegment(wall))
        .slice(0, 3)
        .map((door) => `${door.id}: a=${(door.currentAngle ?? 0).toFixed(2)} v=${(door.angularVelocity ?? 0).toFixed(3)} c=${door.pushContactTicks ?? 0} b=${door.blockedUntilTick ?? 0}`)
        .join(" | ")
      : "";
    if (round.matchWinner) {
      const result = round.matchWinner === snapshot.playerId ? "Victory" : "Defeat";
      this.setHud(`${result} | Final ${score} | ${this.welcome.map.name}${this.rematchRequested ? " | rematch requested" : ""}`);
      this.shell?.querySelector<HTMLElement>(".match-actions")?.removeAttribute("hidden");
      return;
    }
    this.shell?.querySelector<HTMLElement>(".match-actions")?.setAttribute("hidden", "true");
    const objectiveText = round.objective ? `OBJ ${round.objective.owner ? `${round.objective.owner.toUpperCase()} ${Math.floor((round.objective.progressTicks / round.objective.requiredTicks) * 100)}%` : "neutral"}` : "";
    const gadgetButtons = `
      <button class="${this.selectedGadget === "camera" ? "selected" : ""}" data-gadget="camera">CAM ${snapshot.self.gadgets.camera}</button>
      <button class="${this.selectedGadget === "molotov" ? "selected" : ""}" data-gadget="molotov">MOL ${snapshot.self.gadgets.molotov}</button>
      <button class="${this.selectedGadget === "smoke" ? "selected" : ""}" data-gadget="smoke">SMK ${snapshot.self.gadgets.smoke}</button>
      <button class="${this.selectedGadget === "wall" ? "selected" : ""}" data-gadget="wall">WALL ${snapshot.self.gadgets.wall}</button>
      <button class="${this.selectedGadget === "sound" ? "selected" : ""}" data-gadget="sound">SND ${snapshot.self.gadgets.sound}</button>
    `;
    const abilityRemaining = Math.max(0, Math.ceil((snapshot.self.abilityReadyAtTick - snapshot.tick) / TICK_RATE));
    const abilityText = abilityRemaining > 0 ? `${snapshot.self.abilityName} ${abilityRemaining}s` : `Q ${snapshot.self.abilityName}`;
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
        <span class="${abilityRemaining > 0 ? "warn" : ""}">${abilityText}</span>
        ${gadgetButtons}
      </div>
      ${objectiveText ? `<div class="hud-meta compact">${objectiveText}</div>` : ""}
      ${doorDebug ? `<div class="hud-meta">${doorDebug}</div>` : ""}
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

  private updateLoadoutStatus(snapshot?: ServerSnapshot): void {
    const title = this.shell?.querySelector<HTMLElement>("[data-loadout-title]");
    const mode = this.shell?.querySelector<HTMLElement>("[data-loadout-mode]");
    const note = this.shell?.querySelector<HTMLElement>("[data-loadout-note]");
    const details = this.shell?.querySelector<HTMLElement>("[data-loadout-details]");
    if (!title || !mode || !note) return;
    const selectedLoadout = this.currentLoadout();
    if (details) details.innerHTML = loadoutDetailsHtml(selectedLoadout);
    if (!this.welcome) {
      title.textContent = "Starting Loadout";
      mode.textContent = "used when creating or joining";
      note.textContent = formatLoadout(selectedLoadout);
      return;
    }
    title.textContent = "Next Round Loadout";
    mode.textContent = "changes are queued";
    if (snapshot?.nextLoadout) {
      note.textContent = `Queued for next round: ${formatLoadout(snapshot.nextLoadout)}`;
      return;
    }
    if (snapshot && !loadoutMatchesSelf(selectedLoadout, snapshot.self)) {
      note.textContent = `Sending next-round change: ${formatLoadout(selectedLoadout)}`;
      return;
    }
    if (snapshot) {
      note.textContent = `Current round: ${snapshot.self.className} / ${snapshot.self.weaponName}`;
      return;
    }
    note.textContent = `Will apply next round: ${formatLoadout(selectedLoadout)}`;
  }

  private updateMenuOpenClass(): void {
    this.shell?.classList.toggle("menu-open", this.menuOpen);
    const menu = this.shell?.querySelector<HTMLElement>(".escape-menu");
    if (menu) menu.hidden = !this.menuOpen;
  }
}

function formatLoadout(loadout: PlayerLoadoutSelection): string {
  const className = loadout.customClass?.name ?? playerClassPresets[loadout.classId ?? "operator"]?.name ?? "Operator";
  const weaponName = weaponPresets[loadout.weaponId ?? "assault"]?.name ?? "Assault Rifle";
  return `${className} / ${weaponName}`;
}

function loadoutMatchesSelf(loadout: PlayerLoadoutSelection, self: PlayerState): boolean {
  return (loadout.classId ?? "operator") === self.classId && (loadout.weaponId ?? "assault") === self.weaponId;
}

function loadoutDetailsHtml(loadout: PlayerLoadoutSelection): string {
  const playerClass = playerClassPresets[loadout.classId ?? "operator"] ?? playerClassPresets.operator;
  const weapon = weaponPresets[loadout.weaponId ?? "assault"] ?? weaponPresets.assault;
  const gadgets = Object.entries(playerClass.gadgets)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${kind.toUpperCase()} ${count}`)
    .join(" / ");
  return `
    <div><strong>${playerClass.name}</strong><span>Q ${playerClass.ability.name} | ${gadgets || "No gadgets"}</span></div>
    <div><strong>${weapon.name}</strong><span>DMG ${weapon.damage} | RNG ${formatRange(weapon.effectiveRange)} | MAG ${weapon.magSize} | SPD ${weapon.moveSpeed} | VISION ${weapon.visionRange}px / ${Math.round((weapon.visionFov * 180) / Math.PI)}deg${weapon.pelletCount > 1 ? ` | ${weapon.pelletCount} pellets` : ""}</span></div>
  `;
}

function formatRange(range: number): string {
  return Number.isFinite(range) ? `${range}` : "infinite";
}

function roomToPickable(room: RoomSummary) {
  return { id: room.id, name: `${room.id} | ${room.mapName}`, detail: `${room.playerCount}/${room.maxPlayers} ${room.phase}` };
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

function rotateDoorEndpoint(hinge: Vec2, closedB: Vec2, angle: number): Vec2 {
  const length = distance(hinge, closedB);
  const base = Math.atan2(closedB.y - hinge.y, closedB.x - hinge.x);
  return { x: hinge.x + Math.cos(base + angle) * length, y: hinge.y + Math.sin(base + angle) * length };
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
  return !wall.destroyed && (isHingedDoorSegment(wall) || wall.blocksVision);
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
  return !wall.destroyed && (isHingedDoorSegment(wall) || wall.blocksShooting || wall.blocksVision);
}

function reflect(direction: Vec2, wall: Wall): Vec2 {
  const wallDirection = normalize({ x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y });
  const normal = { x: -wallDirection.y, y: wallDirection.x };
  const dot = direction.x * normal.x + direction.y * normal.y;
  return normalize({ x: direction.x - 2 * dot * normal.x, y: direction.y - 2 * dot * normal.y });
}
