import Phaser from "phaser";
import {
  add,
  applySegmentPreset,
  createSegmentFromPreset,
  deleteWallsById,
  distance,
  distanceToSegment,
  insertDoorGap,
  normalizeWallKind,
  replaceWallSection,
  slugifyMapName,
  sub,
  validateDoorSwing,
  wallIntersectsRect,
  type MapDefinition,
  type PlayerId,
  type SegmentPresetId,
  type Spawn,
  type Vec2,
  type Wall
} from "@tac/shared";
import { listMaps, loadMap, saveMap } from "../editorApi";
import { mapSummaryToPickable, pickFromList } from "../fuzzyPicker";
import { colors } from "../render";

type Tool = "select" | "wall" | "window" | "mesh" | "breakable-wall" | "door" | "room" | "objective" | "p1-spawn" | "p2-spawn";
type DragMode =
  | { type: "none" }
  | { type: "pan"; previous: Vec2 }
  | { type: "create"; start: Vec2 }
  | { type: "select-box"; start: Vec2; current: Vec2 }
  | { type: "move"; previous: Vec2 }
  | { type: "spawn"; id: PlayerId }
  | { type: "objective" }
  | { type: "endpoint"; wallId: string; endpoint: "a" | "b" };

interface Blueprint {
  id: string;
  name: string;
  walls: Wall[];
}

const tools: Array<{ id: Tool; label: string }> = [
  { id: "select", label: "Select" },
  { id: "wall", label: "Wall" },
  { id: "window", label: "Window" },
  { id: "mesh", label: "Mesh" },
  { id: "breakable-wall", label: "Breakable" },
  { id: "door", label: "Door" },
  { id: "room", label: "Room" },
  { id: "objective", label: "Objective" },
  { id: "p1-spawn", label: "P1 Spawn" },
  { id: "p2-spawn", label: "P2 Spawn" }
];

const defaultDoorWidth = 64;
const blueprintStorageKey = "tac-shooter-editor-blueprints";

export class EditorScene extends Phaser.Scene {
  private map: MapDefinition = createBlankMap();
  private base: Phaser.GameObjects.Graphics | undefined = undefined;
  private overlay: Phaser.GameObjects.Graphics | undefined = undefined;
  private labels: Phaser.GameObjects.Text[] = [];
  private tool: Tool = "select";
  private selectedIds = new Set<string>();
  private selectedSpawns = new Set<PlayerId>();
  private objectiveSelected = false;
  private drag: DragMode = { type: "none" };
  private pointerWorld: Vec2 = { x: 0, y: 0 };
  private snap = true;
  private doorWidth = defaultDoorWidth;
  private undoStack: MapDefinition[] = [];
  private clipboard: { walls: Wall[]; spawns: Spawn[] } | undefined = undefined;
  private blueprints: Blueprint[] = loadBlueprints();
  private selectedBlueprintId: string | undefined = undefined;
  private lastPick: { point: Vec2; ids: string[]; index: number } | undefined = undefined;
  private root: HTMLElement | undefined = undefined;
  private toolbar: HTMLElement | undefined = undefined;
  private properties: HTMLElement | undefined = undefined;
  private status: HTMLElement | undefined = undefined;
  private preventMiddleMouse = (event: MouseEvent): void => {
    if (event.button !== 1) return;
    event.preventDefault();
  };

  constructor() {
    super("editor");
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.bg);
    this.cameras.main.centerOn(this.map.bounds.width / 2, this.map.bounds.height / 2);
    this.base = this.add.graphics();
    this.overlay = this.add.graphics();
    this.createChrome();
    this.input.on("wheel", (pointer: Phaser.Input.Pointer, _gameObjects: unknown, _dx: number, dy: number) => this.zoomAt(pointer, dy));
    this.input.on("pointerdown", (pointer: Phaser.Input.Pointer) => this.onPointerDown(pointer));
    this.input.on("pointermove", (pointer: Phaser.Input.Pointer) => this.onPointerMove(pointer));
    this.input.on("pointerup", (pointer: Phaser.Input.Pointer) => this.onPointerUp(pointer));
    this.input.on("pointerupoutside", (pointer: Phaser.Input.Pointer) => this.onPointerUp(pointer));
    this.game.canvas.addEventListener("mousedown", this.preventMiddleMouse);
    this.game.canvas.addEventListener("auxclick", this.preventMiddleMouse);
    this.input.keyboard?.on("keydown-DELETE", () => this.deleteSelected());
    this.input.keyboard?.on("keydown-BACKSPACE", () => this.deleteSelected());
    this.input.keyboard?.on("keydown-Z", (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) this.undo();
    });
    this.input.keyboard?.on("keydown-C", (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) this.copySelection();
    });
    this.input.keyboard?.on("keydown-V", (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) this.pasteClipboard();
    });
    this.redraw();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.canvas.removeEventListener("mousedown", this.preventMiddleMouse);
      this.game.canvas.removeEventListener("auxclick", this.preventMiddleMouse);
      this.root?.remove();
    });
  }

  private createChrome(): void {
    this.root = document.createElement("section");
    this.root.className = "editor-shell";
    this.root.innerHTML = `
      <aside class="editor-left">
        <a class="back-link" href="/">Menu</a>
        <h2>Geometry Editor</h2>
        <div class="editor-actions">
          <button data-action="save-as">Save As</button>
          <button data-action="load">Load</button>
        </div>
        <div class="tool-grid"></div>
        <h2>Blueprints</h2>
        <div class="blueprint-panel"></div>
        <p class="editor-hint">Wheel zooms. Middle-drag or Alt-drag pans. Shift-click adds to selection. Drag empty space to box-select. Delete removes selected geometry.</p>
      </aside>
      <aside class="editor-right">
        <h2>Map Settings</h2>
        <div class="map-properties"></div>
        <h2>Selection</h2>
        <div class="properties"></div>
        <p class="save-status"></p>
      </aside>
    `;
    document.body.appendChild(this.root);
    this.toolbar = this.root.querySelector<HTMLElement>(".tool-grid") ?? undefined;
    this.properties = this.root.querySelector<HTMLElement>(".properties") ?? undefined;
    this.status = this.root.querySelector<HTMLElement>(".save-status") ?? undefined;
    this.root.querySelectorAll<HTMLElement>(".editor-left, .editor-right").forEach((panel) => {
      panel.addEventListener("pointerdown", (event) => event.stopPropagation());
      panel.addEventListener("click", (event) => event.stopPropagation());
    });
    this.toolbar!.innerHTML = tools.map((tool) => `<button data-tool="${tool.id}">${tool.label}</button>`).join("");
    this.toolbar!.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-tool]");
      if (!button) return;
      this.tool = button.dataset.tool as Tool;
      this.drag = { type: "none" };
      this.renderChrome();
      this.redraw();
    });
    this.root.querySelector("[data-action='save-as']")?.addEventListener("click", () => void this.saveAs());
    this.root.querySelector("[data-action='load']")?.addEventListener("click", () => void this.chooseMapToLoad());
    this.renderChrome();
  }

  private onPointerDown(pointer: Phaser.Input.Pointer): void {
    if (isMiddleMouse(pointer.event) || isAltLeftMouse(pointer.event)) {
      pointer.event.preventDefault();
      this.drag = { type: "pan", previous: { x: pointer.x, y: pointer.y } };
      return;
    }
    const point = this.worldPoint(pointer);
    this.pointerWorld = point;
    if (this.tool === "door") {
      this.insertDoor(point);
      return;
    }
    if (this.tool === "p1-spawn" || this.tool === "p2-spawn") {
      this.recordUndo();
      this.placeSpawn(this.tool === "p1-spawn" ? "p1" : "p2", point);
      return;
    }
    if (this.tool === "objective") {
      this.recordUndo();
      this.placeObjective(point);
      return;
    }
    if (this.tool === "wall" || this.tool === "window" || this.tool === "mesh" || this.tool === "breakable-wall" || this.tool === "room") {
      this.drag = { type: "create", start: point };
      return;
    }

    const spawn = this.pickSpawn(point);
    if (spawn) {
      this.recordUndo();
      this.selectedIds.clear();
      this.selectedSpawns = new Set([spawn.id]);
      this.objectiveSelected = false;
      this.drag = { type: "spawn", id: spawn.id };
      this.renderChrome();
      this.redraw();
      return;
    }

    const handle = this.pickEndpoint(point);
    if (handle) {
      this.recordUndo();
      this.selectedIds = new Set([handle.wallId]);
      this.selectedSpawns.clear();
      this.objectiveSelected = false;
      this.drag = { type: "endpoint", wallId: handle.wallId, endpoint: handle.endpoint };
      this.renderChrome();
      this.redraw();
      return;
    }

    if (this.pickObjective(point)) {
      this.recordUndo();
      this.selectedIds.clear();
      this.selectedSpawns.clear();
      this.objectiveSelected = true;
      this.drag = { type: "objective" };
      this.renderChrome();
      this.redraw();
      return;
    }

    const picked = this.pickWall(point, false, true);
    if (picked) {
      this.recordUndo();
      this.updateSelection(picked, pointer.event.shiftKey);
      this.drag = { type: "move", previous: point };
    } else {
      if (!pointer.event.shiftKey) this.selectedIds.clear();
      if (!pointer.event.shiftKey) this.selectedSpawns.clear();
      if (!pointer.event.shiftKey) this.objectiveSelected = false;
      this.drag = { type: "select-box", start: point, current: point };
    }
    this.renderChrome();
    this.redraw();
  }

  private onPointerMove(pointer: Phaser.Input.Pointer): void {
    if (this.drag.type === "pan") {
      const camera = this.cameras.main;
      const dx = pointer.x - this.drag.previous.x;
      const dy = pointer.y - this.drag.previous.y;
      camera.scrollX -= dx / camera.zoom;
      camera.scrollY -= dy / camera.zoom;
      this.drag.previous = { x: pointer.x, y: pointer.y };
      return;
    }
    const point = this.worldPoint(pointer);
    this.pointerWorld = point;
    if (this.drag.type === "move") {
      const delta = sub(point, this.drag.previous);
      this.moveSelected(delta);
      this.drag.previous = point;
    } else if (this.drag.type === "spawn") {
      this.placeSpawn(this.drag.id, point, false);
    } else if (this.drag.type === "objective") {
      this.placeObjective(point, false);
    } else if (this.drag.type === "endpoint") {
      const wall = this.findWall(this.drag.wallId);
      if (wall) wall[this.drag.endpoint] = point;
    } else if (this.drag.type === "select-box") {
      this.drag.current = point;
    }
    this.redraw();
  }

  private onPointerUp(pointer: Phaser.Input.Pointer): void {
    if (this.drag.type === "pan") {
      pointer.event.preventDefault();
      this.drag = { type: "none" };
      return;
    }
    const point = this.worldPoint(pointer);
    if (this.drag.type === "create") {
      this.recordUndo();
      if (this.tool === "room") this.createRoomWalls(this.drag.start, point);
      else this.createSegment(this.drag.start, point, toolToPreset(this.tool));
    } else if (this.drag.type === "select-box") {
      this.selectWallsInRect(this.drag.start, this.drag.current, pointer.event.shiftKey);
    }
    const wasSelectBox = this.drag.type === "select-box";
    this.drag = { type: "none" };
    if (wasSelectBox) this.renderChrome();
    this.redraw();
  }

  private createSegment(a: Vec2, b: Vec2, preset: SegmentPresetId): void {
    if (distance(a, b) < 8) return;
    const wall = createSegmentFromPreset(nextId(preset, this.map.walls), preset, a, b);
    this.map.walls = preset === "window" || preset === "mesh" ? replaceWallSection(this.map.walls, wall) : [...this.map.walls, wall];
    this.selectedIds = new Set([wall.id]);
    this.selectedSpawns.clear();
    this.objectiveSelected = false;
  }

  private createRoomWalls(a: Vec2, b: Vec2): void {
    const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
    if (max.x - min.x < 24 || max.y - min.y < 24) return;
    const roomId = nextId("room", this.map.walls);
    const corners = {
      nw: { x: min.x, y: min.y },
      ne: { x: max.x, y: min.y },
      se: { x: max.x, y: max.y },
      sw: { x: min.x, y: max.y }
    };
    const walls = [
      createSegmentFromPreset(`${roomId}-north`, "wall", corners.nw, corners.ne, { roomId, label: roomId }),
      createSegmentFromPreset(`${roomId}-east`, "wall", corners.ne, corners.se, { roomId, label: roomId }),
      createSegmentFromPreset(`${roomId}-south`, "wall", corners.se, corners.sw, { roomId, label: roomId }),
      createSegmentFromPreset(`${roomId}-west`, "wall", corners.sw, corners.nw, { roomId, label: roomId })
    ];
    this.map.walls = [...this.map.walls, ...walls];
    this.selectedIds = new Set(walls.map((wall) => wall.id));
    this.selectedSpawns.clear();
    this.objectiveSelected = false;
  }

  private insertDoor(point: Vec2): void {
    const wall = this.pickWall(point, true);
    if (!wall) return;
    const prefix = nextId("door", this.map.walls);
    const nextWalls = insertDoorGap(this.map.walls, wall.id, point, this.doorWidth, prefix);
    const door = nextWalls.find((candidate) => candidate.id === `${prefix}-door`);
    const validation = door ? validateDoorSwing(nextWalls, door) : { valid: false };
    if (!validation.valid) {
      this.setStatus(`Invalid door: swing blocked by ${validation.blockerId ?? "geometry"}.`);
      return;
    }
    this.recordUndo();
    this.map.walls = nextWalls;
    this.selectedIds = new Set([`${prefix}-door`]);
    this.selectedSpawns.clear();
    this.objectiveSelected = false;
    this.renderChrome();
    this.redraw();
  }

  private moveSelected(delta: Vec2): void {
    if (delta.x === 0 && delta.y === 0) return;
    for (const wall of this.map.walls) {
      if (!this.selectedIds.has(wall.id)) continue;
      wall.a = add(wall.a, delta);
      wall.b = add(wall.b, delta);
    }
  }

  private placeSpawn(id: PlayerId, position: Vec2, select = true): void {
    const spawn = this.map.spawns.find((candidate) => candidate.id === id);
    if (spawn) spawn.position = position;
    else this.map.spawns.push({ id, team: id === "p1" ? "blue" : "orange", position, angle: id === "p1" ? 0 : Math.PI });
    if (select) {
      this.selectedIds.clear();
      this.selectedSpawns = new Set([id]);
      this.objectiveSelected = false;
      this.tool = "select";
    }
    this.renderChrome();
    this.redraw();
  }

  private placeObjective(position: Vec2, select = true): void {
    this.map.objective = { id: "objective", position, radius: this.map.objective?.radius ?? 56 };
    if (select) {
      this.selectedIds.clear();
      this.selectedSpawns.clear();
      this.objectiveSelected = true;
      this.tool = "select";
    }
    this.renderChrome();
    this.redraw();
  }

  private setObjectiveRadius(radius: number): void {
    const position = this.map.objective?.position ?? { x: this.map.bounds.width / 2, y: this.map.bounds.height / 2 };
    this.map.objective = { id: "objective", position, radius };
  }

  private setTeamSize(teamSize: number): void {
    const blueExisting = orderedTeamSpawns(this.map.spawns, "blue");
    const orangeExisting = orderedTeamSpawns(this.map.spawns, "orange");
    const blue = Array.from({ length: teamSize }, (_, index) => spawnForIndex(index + 1, index, teamSize, "blue", this.map.bounds, blueExisting[index]));
    const orange = Array.from({ length: teamSize }, (_, index) => spawnForIndex(teamSize + index + 1, index, teamSize, "orange", this.map.bounds, orangeExisting[index]));
    this.map.spawns = [...blue, ...orange];
    this.selectedSpawns = new Set([...this.selectedSpawns].filter((id) => this.map.spawns.some((spawn) => spawn.id === id)));
    this.renderChrome();
  }

  private deleteSelected(): void {
    if (this.selectedIds.size === 0 && this.selectedSpawns.size === 0 && !this.objectiveSelected) return;
    this.recordUndo();
    this.map.walls = deleteWallsById(this.map.walls, this.selectedIds);
    if (this.objectiveSelected) delete this.map.objective;
    this.selectedIds.clear();
    this.selectedSpawns.clear();
    this.objectiveSelected = false;
    this.renderChrome();
    this.redraw();
  }

  private redraw(): void {
    if (!this.base || !this.overlay) return;
    clearLabels(this.labels);
    this.labels = [];
    this.drawBase();
    this.overlay.clear();
    for (const wall of this.map.walls) this.drawEditorWall(wall);
    this.drawSpawns();
    this.drawObjective();
    this.drawCreationPreview();
    this.drawDoorPreview();
    this.drawSelectionBox();
  }

  private drawBase(): void {
    const gridSize = this.map.gridSize ?? 40;
    this.base!.clear();
    this.base!.fillStyle(colors.bg, 1);
    this.base!.fillRect(0, 0, this.map.bounds.width, this.map.bounds.height);
    this.base!.lineStyle(1, colors.grid, 0.55);
    for (let x = 0; x <= this.map.bounds.width; x += gridSize) this.base!.lineBetween(x, 0, x, this.map.bounds.height);
    for (let y = 0; y <= this.map.bounds.height; y += gridSize) this.base!.lineBetween(0, y, this.map.bounds.width, y);
    this.base!.lineStyle(3, 0x2f6174, 0.9);
    this.base!.strokeRect(0, 0, this.map.bounds.width, this.map.bounds.height);
  }

  private drawEditorWall(wall: Wall): void {
    const preset = normalizedPreset(wall);
    const selected = this.selectedIds.has(wall.id);
    if (wall.destructible) this.drawDestructibleOutline(wall);
    
    if (preset === "mesh") {
      // Draw mesh walls as X's
      const dx = wall.b.x - wall.a.x;
      const dy = wall.b.y - wall.a.y;
      const length = Math.hypot(dx, dy);
      const offset = 8; // Fixed pixel offset
      this.overlay!.lineStyle(selected ? (wall.thickness + 7) / 2 : wall.thickness / 2, selected ? colors.warning : 0xb6f2df, selected ? 0.95 : 0.9);
      if (length > 0) {
        const normX = dx / length;
        const normY = dy / length;
        const perpX = -normY * offset;
        const perpY = normX * offset;
        this.overlay!.lineBetween(wall.a.x - perpX, wall.a.y - perpY, wall.b.x + perpX, wall.b.y + perpY);
        this.overlay!.lineBetween(wall.a.x + perpX, wall.a.y + perpY, wall.b.x - perpX, wall.b.y - perpY);
      }
    } else if (preset === "window") {
      // Draw transparent walls as dashed lines
      this.overlay!.lineStyle(selected ? wall.thickness + 7 : wall.thickness, selected ? colors.warning : 0x67d7ff, selected ? 0.95 : 0.5);
      drawDashedLine(this.overlay!, wall.a, wall.b, 18, 8);
    } else {
      // Draw other walls normally
      const color = preset === "door" ? colors.sensor : colors.wall;
      this.overlay!.lineStyle(selected ? wall.thickness + 7 : wall.thickness, selected ? colors.warning : color, selected ? 0.95 : 0.9);
      this.overlay!.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
      
      // Draw door swing arc
      if (preset === "door" && wall.hinge && wall.closedB) {
        const hingePos = wall.hinge;
        const length = Math.hypot(wall.closedB.x - hingePos.x, wall.closedB.y - hingePos.y);
        const closedAngle = Math.atan2(wall.closedB.y - hingePos.y, wall.closedB.x - hingePos.x);
        const maxAngle = 1.92; // From config
        
        // Draw radius circle in faint color
        this.overlay!.lineStyle(1, colors.sensor, 0.3);
        this.overlay!.strokeCircle(hingePos.x, hingePos.y, length);
        
        // Draw arc showing swing range
        this.overlay!.lineStyle(2, colors.sensor, 0.85);
        this.overlay!.beginPath();
        this.overlay!.moveTo(hingePos.x, hingePos.y);
        this.overlay!.arc(hingePos.x, hingePos.y, length, closedAngle - maxAngle, closedAngle + maxAngle, false);
        this.overlay!.lineTo(hingePos.x, hingePos.y);
        this.overlay!.closePath();
        this.overlay!.strokePath();
        
        // Draw hinge point
        this.overlay!.fillStyle(colors.sensor, 0.8);
        this.overlay!.fillCircle(hingePos.x, hingePos.y, 4);
      }
    }
    
    this.overlay!.lineStyle(1, preset === "door" ? colors.sensor : preset === "mesh" ? 0xb6f2df : preset === "window" ? 0x67d7ff : colors.wall, 0.8);
    this.overlay!.strokeCircle(wall.a.x, wall.a.y, selected ? 8 : 5);
    this.overlay!.strokeCircle(wall.b.x, wall.b.y, selected ? 8 : 5);
    const label = wall.label || presetLabel(preset);
    if (preset !== "wall" || wall.roomId || wall.destructible || selected) this.label((wall.a.x + wall.b.x) / 2 + 6, (wall.a.y + wall.b.y) / 2 + 6, `${label.toUpperCase()}${wall.destructible ? " / DESTRUCTIBLE" : ""}`);
  }

  private drawDestructibleOutline(wall: Wall): void {
    this.overlay!.lineStyle(Math.max(2, wall.thickness + 4), colors.destructible, 0.72);
    this.overlay!.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
    this.overlay!.lineStyle(1, colors.destructible, 0.95);
    this.overlay!.strokeCircle(wall.a.x, wall.a.y, Math.max(5, wall.thickness / 2 + 3));
    this.overlay!.strokeCircle(wall.b.x, wall.b.y, Math.max(5, wall.thickness / 2 + 3));
  }

  private drawSpawns(): void {
    for (const spawn of this.map.spawns) {
      const selected = this.selectedSpawns.has(spawn.id);
      const color = spawn.team === "blue" ? colors.blue : colors.orange;
      this.overlay!.lineStyle(selected ? 4 : 2, selected ? colors.warning : color, 0.95);
      this.overlay!.strokeCircle(spawn.position.x, spawn.position.y, selected ? 16 : 12);
      this.overlay!.fillStyle(color, 0.85);
      this.overlay!.fillCircle(spawn.position.x, spawn.position.y, 6);
      this.label(spawn.position.x + 12, spawn.position.y - 10, `${spawn.id.toUpperCase()} SPAWN`);
    }
  }

  private drawObjective(): void {
    const objective = this.map.objective;
    if (!objective) return;
    this.overlay!.lineStyle(this.objectiveSelected ? 4 : 2, this.objectiveSelected ? colors.warning : colors.destructible, 0.9);
    this.overlay!.strokeCircle(objective.position.x, objective.position.y, objective.radius);
    this.overlay!.fillStyle(colors.destructible, 0.12);
    this.overlay!.fillCircle(objective.position.x, objective.position.y, objective.radius);
    this.overlay!.fillStyle(colors.destructible, 0.88);
    this.overlay!.fillCircle(objective.position.x, objective.position.y, 6);
    this.label(objective.position.x + 12, objective.position.y - 10, "OBJECTIVE");
  }

  private drawCreationPreview(): void {
    if (this.drag.type !== "create") return;
    const preset = toolToPreset(this.tool);
    this.overlay!.lineStyle(2, colors.sensor, 0.9);
    if (this.tool === "room") {
      const min = { x: Math.min(this.drag.start.x, this.pointerWorld.x), y: Math.min(this.drag.start.y, this.pointerWorld.y) };
      const width = Math.abs(this.drag.start.x - this.pointerWorld.x);
      const height = Math.abs(this.drag.start.y - this.pointerWorld.y);
      this.overlay!.strokeRect(min.x, min.y, width, height);
    } else {
      this.overlay!.lineBetween(this.drag.start.x, this.drag.start.y, this.pointerWorld.x, this.pointerWorld.y);
      this.label(this.pointerWorld.x + 8, this.pointerWorld.y + 8, presetLabel(preset));
    }
  }

  private drawDoorPreview(): void {
    if (this.tool !== "door" || this.drag.type !== "none") return;
    const wall = this.pickWall(this.pointerWorld, true);
    if (!wall) return;
    const prefix = "__preview-door";
    const nextWalls = insertDoorGap(this.map.walls, wall.id, this.pointerWorld, this.doorWidth, prefix);
    const door = nextWalls.find((candidate) => candidate.id === `${prefix}-door`);
    if (!door) return;
    const validation = validateDoorSwing(nextWalls, door);
    this.overlay!.lineStyle(3, validation.valid ? colors.sensor : colors.warning, 0.9);
    this.overlay!.lineBetween(door.a.x, door.a.y, door.b.x, door.b.y);
    this.label((door.a.x + door.b.x) / 2 + 8, (door.a.y + door.b.y) / 2 + 8, validation.valid ? "DOOR" : `BLOCKED: ${validation.blockerId ?? "GEOMETRY"}`);
  }

  private drawSelectionBox(): void {
    if (this.drag.type !== "select-box") return;
    const min = { x: Math.min(this.drag.start.x, this.drag.current.x), y: Math.min(this.drag.start.y, this.drag.current.y) };
    const max = { x: Math.max(this.drag.start.x, this.drag.current.x), y: Math.max(this.drag.start.y, this.drag.current.y) };
    this.overlay!.lineStyle(1, colors.sensor, 0.75);
    this.overlay!.strokeRect(min.x, min.y, max.x - min.x, max.y - min.y);
  }

  private renderChrome(): void {
    this.toolbar?.querySelectorAll("button").forEach((button) => button.classList.toggle("active", button.getAttribute("data-tool") === this.tool));
    this.renderBlueprints();
    this.renderMapProperties();
    this.renderSelectionProperties();
  }

  private renderBlueprints(): void {
    const container = this.root?.querySelector<HTMLElement>(".blueprint-panel");
    if (!container) return;
    container.innerHTML = `
      <div class="blueprint-actions">
        <button data-blueprint-action="save">Save Selection</button>
        <button data-blueprint-action="place" ${this.selectedBlueprintId ? "" : "disabled"}>Place</button>
        <button data-blueprint-action="delete" ${this.selectedBlueprintId ? "" : "disabled"}>Delete</button>
      </div>
      <div class="blueprint-list">
        ${this.blueprints.length === 0
          ? `<span>No blueprints saved.</span>`
          : this.blueprints.map((blueprint) => `<button class="${blueprint.id === this.selectedBlueprintId ? "active" : ""}" data-blueprint="${blueprint.id}">${escapeAttr(blueprint.name)}<span>${blueprint.walls.length} segment(s)</span></button>`).join("")}
      </div>
    `;
    container.querySelector("[data-blueprint-action='save']")?.addEventListener("click", () => this.saveBlueprint());
    container.querySelector("[data-blueprint-action='place']")?.addEventListener("click", () => this.placeBlueprint());
    container.querySelector("[data-blueprint-action='delete']")?.addEventListener("click", () => this.deleteBlueprint());
    container.querySelectorAll<HTMLButtonElement>("[data-blueprint]").forEach((button) => {
      button.addEventListener("click", () => {
        this.selectedBlueprintId = button.dataset.blueprint;
        this.renderChrome();
      });
    });
  }

  private renderMapProperties(): void {
    const container = this.root?.querySelector<HTMLElement>(".map-properties");
    if (!container) return;
    container.innerHTML = `
      <label>Name <input data-map-field="name" value="${escapeAttr(this.map.name)}"></label>
      ${numberField("bounds.width", this.map.bounds.width)}
      ${numberField("bounds.height", this.map.bounds.height)}
      ${numberField("gridSize", this.map.gridSize ?? 40)}
      ${numberField("teamSize", teamSizeFromSpawns(this.map.spawns))}
      ${numberField("objectiveRadius", this.map.objective?.radius ?? 56)}
      ${numberField("doorWidth", this.doorWidth)}
      <label class="check-row">snap to grid <input type="checkbox" data-map-field="snap" ${this.snap ? "checked" : ""}></label>
    `;
    container.querySelectorAll<HTMLInputElement>("[data-map-field]").forEach((input) => {
      onEditorControlCommit(input, () => this.applyMapField(input));
    });
  }

  private renderSelectionProperties(): void {
    if (!this.properties) return;
    const selected = this.map.walls.filter((wall) => this.selectedIds.has(wall.id));
    const selectedSpawn = this.map.spawns.find((spawn) => this.selectedSpawns.has(spawn.id));
    if (this.objectiveSelected && this.map.objective) {
      this.properties.innerHTML = `
        <p>Objective</p>
        ${numberField("objective.position.x", this.map.objective.position.x)}
        ${numberField("objective.position.y", this.map.objective.position.y)}
        ${numberField("objective.radius", this.map.objective.radius)}
      `;
      this.properties.querySelectorAll<HTMLInputElement>("[data-field]").forEach((input) => {
        onEditorControlCommit(input, () => {
          this.recordUndo();
          this.applyObjectiveField(input.dataset.field!, Number(input.value));
          this.redraw();
        });
      });
      return;
    }
    if (selectedSpawn) {
      this.properties.innerHTML = `
        <p>${selectedSpawn.id.toUpperCase()} spawn</p>
        ${selectField("team", selectedSpawn.team, ["blue", "orange"])}
        ${numberField("position.x", selectedSpawn.position.x)}
        ${numberField("position.y", selectedSpawn.position.y)}
        ${numberField("angle", selectedSpawn.angle)}
      `;
      this.properties.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
        onEditorControlCommit(input, () => {
          this.recordUndo();
          const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
          applySpawnField(selectedSpawn, input.dataset.field!, value);
          this.redraw();
        });
      });
      return;
    }
    if (selected.length === 0) {
      this.properties.innerHTML = `<p>No geometry selected.</p>`;
      return;
    }
    if (selected.length > 1) {
      this.properties.innerHTML = `
        <p>${selected.length} objects selected.</p>
        ${selectField("preset", "wall", ["wall", "window", "mesh", "breakable-wall", "door", "deployable-wall"])}
        ${numberField("thickness", selected[0]?.thickness ?? 12)}
        ${checkField("destructible", selected.every((wall) => wall.destructible))}
        ${selected.some((wall) => wall.destructible) ? numberField("maxHp", selected[0]?.maxHp ?? defaultDestructibleHp(selected[0])) : ""}
        ${checkField("blocksVision", selected.every((wall) => wall.blocksVision))}
        ${checkField("blocksMovement", selected.every((wall) => wall.blocksMovement))}
        ${checkField("blocksShooting", selected.every((wall) => wall.blocksShooting))}
      `;
      this.properties.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
        onEditorControlCommit(input, () => {
          const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
          this.recordUndo();
          for (const wall of selected) applyWallField(wall, input.dataset.field!, value);
          this.redraw();
        });
      });
      return;
    }
    const wall = selected[0]!;
    this.properties.innerHTML = `
      <label>id <input data-field="id" value="${escapeAttr(wall.id)}"></label>
      <label>label <input data-field="label" value="${escapeAttr(wall.label ?? "")}"></label>
      ${selectField("preset", normalizedPreset(wall), ["wall", "window", "mesh", "breakable-wall", "door", "deployable-wall"])}
      ${numberField("a.x", wall.a.x)}
      ${numberField("a.y", wall.a.y)}
      ${numberField("b.x", wall.b.x)}
      ${numberField("b.y", wall.b.y)}
      ${numberField("thickness", wall.thickness)}
      ${checkField("destructible", wall.destructible)}
      ${wall.destructible ? numberField("maxHp", wall.maxHp ?? defaultDestructibleHp(wall)) : ""}
      ${checkField("blocksVision", wall.blocksVision)}
      ${checkField("blocksMovement", wall.blocksMovement)}
      ${checkField("blocksShooting", wall.blocksShooting)}
    `;
    this.properties.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
      onEditorControlCommit(input, () => {
        const oldId = wall.id;
        const value = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value;
        this.recordUndo();
        applyWallField(wall, input.dataset.field!, value);
        if (input.dataset.field === "id" && typeof value === "string" && value !== oldId) {
          this.selectedIds.delete(oldId);
          this.selectedIds.add(value);
        }
        this.redraw();
      });
    });
  }

  private applyMapField(input: HTMLInputElement): void {
    const field = input.dataset.mapField;
    if (!field) return;
    this.recordUndo();
    if (field === "snap") this.snap = input.checked;
    else if (field === "name") this.map.name = input.value;
    else if (field === "gridSize") this.map.gridSize = Math.max(4, Number(input.value) || 40);
    else if (field === "teamSize") this.setTeamSize(Math.max(1, Math.min(8, Number(input.value) || 1)));
    else if (field === "objectiveRadius") this.setObjectiveRadius(Math.max(12, Number(input.value) || 56));
    else if (field === "doorWidth") this.doorWidth = Math.max(8, Number(input.value) || defaultDoorWidth);
    else if (field === "bounds.width") this.map.bounds.width = Math.max(80, Number(input.value) || this.map.bounds.width);
    else if (field === "bounds.height") this.map.bounds.height = Math.max(80, Number(input.value) || this.map.bounds.height);
    this.redraw();
  }

  private applyObjectiveField(field: string, value: number): void {
    if (!this.map.objective) return;
    if (field === "objective.position.x") this.map.objective.position.x = value;
    if (field === "objective.position.y") this.map.objective.position.y = value;
    if (field === "objective.radius") this.map.objective.radius = Math.max(12, value);
  }

  private updateSelection(wall: Wall, additive: boolean): void {
    if (!additive) this.selectedIds.clear();
    if (!additive) this.selectedSpawns.clear();
    if (!additive) this.objectiveSelected = false;
    if (additive && this.selectedIds.has(wall.id)) this.selectedIds.delete(wall.id);
    else this.selectedIds.add(wall.id);
  }

  private selectWallsInRect(a: Vec2, b: Vec2, additive: boolean): void {
    const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
    if (!additive) this.selectedIds.clear();
    if (!additive) this.selectedSpawns.clear();
    if (!additive) this.objectiveSelected = false;
    for (const wall of this.map.walls) {
      if (wallIntersectsRect(wall, min, max)) this.selectedIds.add(wall.id);
    }
  }

  private pickSpawn(point: Vec2): Spawn | undefined {
    return [...this.map.spawns].reverse().find((spawn) => distance(point, spawn.position) <= 18);
  }

  private pickObjective(point: Vec2): boolean {
    return Boolean(this.map.objective && distance(point, this.map.objective.position) <= Math.max(18, this.map.objective.radius));
  }

  private pickWall(point: Vec2, includeDoor = false, cycle = false): Wall | undefined {
    const candidates = [...this.map.walls]
      .reverse()
      .filter((wall) => (includeDoor || normalizedPreset(wall) !== "door") && distanceToSegment(point, wall.a, wall.b) <= Math.max(12, wall.thickness + 6));
    if (candidates.length === 0) {
      this.lastPick = undefined;
      return undefined;
    }
    if (!cycle || candidates.length === 1) {
      this.lastPick = { point, ids: candidates.map((wall) => wall.id), index: 0 };
      return candidates[0];
    }
    const ids = candidates.map((wall) => wall.id);
    const sameStack = this.lastPick && distance(point, this.lastPick.point) <= Math.max(8, this.map.gridSize ?? 40) && ids.join("|") === this.lastPick.ids.join("|");
    const index = sameStack ? (this.lastPick!.index + 1) % candidates.length : 0;
    this.lastPick = { point, ids, index };
    return candidates[index];
  }

  private pickEndpoint(point: Vec2): { wallId: string; endpoint: "a" | "b" } | undefined {
    for (const wall of [...this.map.walls].reverse()) {
      if (distance(point, wall.a) <= 12) return { wallId: wall.id, endpoint: "a" };
      if (distance(point, wall.b) <= 12) return { wallId: wall.id, endpoint: "b" };
    }
    return undefined;
  }

  private findWall(id: string): Wall | undefined {
    return this.map.walls.find((wall) => wall.id === id);
  }

  private async chooseMapToLoad(): Promise<void> {
    try {
      const maps = await listMaps();
      if (maps.length === 0) {
        this.setStatus("No saved maps found.");
        return;
      }
      const choice = await pickFromList("Load Map", maps.map(mapSummaryToPickable));
      if (!choice) return;
      this.recordUndo();
      this.map = normalizeMap(await loadMap(choice.id));
      this.selectedIds.clear();
      this.selectedSpawns.clear();
      this.objectiveSelected = false;
      this.setStatus(`Loaded ${this.map.name}`);
      this.renderChrome();
      this.redraw();
    } catch (error) {
      this.setStatus(error instanceof Error ? error.message : "Unable to list maps");
    }
  }

  private async saveAs(): Promise<void> {
    const name = window.prompt("Map name", this.map.name);
    if (!name) return;
    this.recordUndo();
    const id = slugifyMapName(name);
    this.map = normalizeMap({ ...this.map, id, name, version: this.map.version + 1 });
    this.map = normalizeMap(await saveMap(this.map));
    this.setStatus(`Saved maps/${id}.json`);
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.map = normalizeMap(previous);
    this.selectedIds.clear();
    this.selectedSpawns.clear();
    this.objectiveSelected = false;
    this.drag = { type: "none" };
    this.setStatus("Undid last edit.");
    this.renderChrome();
    this.redraw();
  }

  private copySelection(): void {
    const walls = this.map.walls.filter((wall) => this.selectedIds.has(wall.id)).map((wall) => structuredClone(wall));
    const spawns = this.map.spawns.filter((spawn) => this.selectedSpawns.has(spawn.id)).map((spawn) => structuredClone(spawn));
    if (walls.length === 0 && spawns.length === 0) return;
    this.clipboard = { walls, spawns };
    this.setStatus(`Copied ${walls.length + spawns.length} object(s).`);
  }

  private pasteClipboard(): void {
    if (!this.clipboard) return;
    this.recordUndo();
    const offset = this.map.gridSize ?? 40;
    this.selectedIds.clear();
    this.selectedSpawns.clear();
    this.objectiveSelected = false;
    for (const copied of this.clipboard.walls) {
      const wall = structuredClone(copied);
      wall.id = nextId(wall.preset ?? "wall", this.map.walls);
      wall.a = add(wall.a, { x: offset, y: offset });
      wall.b = add(wall.b, { x: offset, y: offset });
      if (wall.roomId) wall.roomId = `${wall.roomId}-copy`;
      this.map.walls.push(wall);
      this.selectedIds.add(wall.id);
    }
    for (const copied of this.clipboard.spawns) {
      this.placeSpawn(copied.id, add(copied.position, { x: offset, y: offset }), false);
      this.selectedSpawns.add(copied.id);
    }
    this.setStatus("Pasted clipboard.");
    this.renderChrome();
    this.redraw();
  }

  private recordUndo(): void {
    this.undoStack.push(structuredClone(this.map));
    if (this.undoStack.length > 80) this.undoStack.shift();
  }

  private saveBlueprint(): void {
    const selected = this.map.walls.filter((wall) => this.selectedIds.has(wall.id));
    if (selected.length === 0) {
      this.setStatus("Select geometry before saving a blueprint.");
      return;
    }
    const name = window.prompt("Blueprint name", `Blueprint ${this.blueprints.length + 1}`);
    if (!name) return;
    const origin = blueprintOrigin(selected);
    const blueprint: Blueprint = {
      id: slugifyMapName(name),
      name,
      walls: selected.map((wall) => ({
        ...structuredClone(wall),
        a: sub(wall.a, origin),
        b: sub(wall.b, origin),
        ...(wall.hinge ? { hinge: sub(wall.hinge, origin) } : {}),
        ...(wall.closedA ? { closedA: sub(wall.closedA, origin) } : {}),
        ...(wall.closedB ? { closedB: sub(wall.closedB, origin) } : {})
      }))
    };
    this.blueprints = [...this.blueprints.filter((candidate) => candidate.id !== blueprint.id), blueprint];
    this.selectedBlueprintId = blueprint.id;
    saveBlueprints(this.blueprints);
    this.setStatus(`Saved blueprint ${name}.`);
    this.renderChrome();
  }

  private placeBlueprint(): void {
    const blueprint = this.blueprints.find((candidate) => candidate.id === this.selectedBlueprintId);
    if (!blueprint) return;
    this.recordUndo();
    const origin = this.snapPoint(this.pointerWorld);
    this.selectedIds.clear();
    this.selectedSpawns.clear();
    for (const stored of blueprint.walls) {
      const wall = structuredClone(stored);
      const prefix = wall.preset ?? "blueprint";
      wall.id = nextId(prefix, this.map.walls);
      wall.a = add(origin, wall.a);
      wall.b = add(origin, wall.b);
      if (wall.hinge) wall.hinge = add(origin, wall.hinge);
      if (wall.closedA) wall.closedA = add(origin, wall.closedA);
      if (wall.closedB) wall.closedB = add(origin, wall.closedB);
      this.map.walls.push(wall);
      this.selectedIds.add(wall.id);
    }
    this.setStatus(`Placed blueprint ${blueprint.name}.`);
    this.renderChrome();
    this.redraw();
  }

  private deleteBlueprint(): void {
    if (!this.selectedBlueprintId) return;
    this.blueprints = this.blueprints.filter((blueprint) => blueprint.id !== this.selectedBlueprintId);
    this.selectedBlueprintId = undefined;
    saveBlueprints(this.blueprints);
    this.renderChrome();
  }

  private zoomAt(pointer: Phaser.Input.Pointer, deltaY: number): void {
    const camera = this.cameras.main;
    const before = camera.getWorldPoint(pointer.x, pointer.y);
    camera.setZoom(Phaser.Math.Clamp(camera.zoom * (deltaY > 0 ? 0.9 : 1.1), 0.35, 3));
    const after = camera.getWorldPoint(pointer.x, pointer.y);
    camera.scrollX += before.x - after.x;
    camera.scrollY += before.y - after.y;
  }

  private worldPoint(pointer: Phaser.Input.Pointer): Vec2 {
    const point = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    return this.snapPoint({ x: point.x, y: point.y });
  }

  private snapPoint(point: Vec2): Vec2 {
    if (!this.snap) return { x: Math.round(point.x), y: Math.round(point.y) };
    const grid = this.map.gridSize ?? 40;
    return { x: Math.round(point.x / grid) * grid, y: Math.round(point.y / grid) * grid };
  }

  private label(x: number, y: number, text: string): void {
    this.labels.push(this.add.text(x, y, text, { color: "#d7f3ff", fontSize: "11px", backgroundColor: "rgba(3, 8, 12, 0.68)", padding: { x: 4, y: 2 } }));
  }

  private setStatus(message: string): void {
    if (this.status) this.status.textContent = message;
  }
}

function normalizeMap(map: MapDefinition): MapDefinition {
  return {
    ...map,
    gridSize: map.gridSize ?? 40,
    rooms: map.rooms ?? [],
    utilityPlacements: map.utilityPlacements ?? [],
    lighting: map.lighting ?? [],
    ...(map.objective ? { objective: { id: map.objective.id || "objective", position: { ...map.objective.position }, radius: map.objective.radius || 56 } } : {}),
    notes: map.notes ?? "",
    walls: map.walls.map(normalizeWallKind)
  };
}

function isMiddleMouse(event: MouseEvent | TouchEvent | WheelEvent): event is MouseEvent {
  return "button" in event && event.button === 1;
}

function isAltLeftMouse(event: MouseEvent | TouchEvent | WheelEvent): event is MouseEvent {
  return "button" in event && event.button === 0 && event.altKey;
}

function createBlankMap(): MapDefinition {
  return normalizeMap({
    id: "untitled-map",
    version: 1,
    name: "Untitled Map",
    bounds: { width: 960, height: 640 },
    gridSize: 40,
    rooms: [],
    walls: [],
    spawns: [
      { id: "p1", team: "blue", position: { x: 120, y: 320 }, angle: 0 },
      { id: "p2", team: "orange", position: { x: 840, y: 320 }, angle: Math.PI }
    ],
    sensors: [],
    utilityPlacements: [],
    lighting: [],
    notes: ""
  });
}

function teamSizeFromSpawns(spawns: Spawn[]): number {
  return Math.max(1, spawns.filter((spawn) => spawn.team === "blue").length, spawns.filter((spawn) => spawn.team === "orange").length);
}

function orderedTeamSpawns(spawns: Spawn[], team: "blue" | "orange"): Spawn[] {
  return spawns
    .filter((spawn) => spawn.team === team)
    .sort((a, b) => playerNumber(a.id) - playerNumber(b.id));
}

function spawnForIndex(index: number, slot: number, teamSize: number, team: "blue" | "orange", bounds: MapDefinition["bounds"], previous?: Spawn): Spawn {
  const id = `p${index}` as PlayerId;
  const lane = team === "blue" ? 0.22 : 0.78;
  const spacing = Math.min(72, bounds.height / Math.max(4, teamSize + 1));
  const y = bounds.height / 2 + (slot - (teamSize - 1) / 2) * spacing;
  return {
    id,
    team,
    position: previous ? { ...previous.position } : { x: bounds.width * lane, y },
    angle: previous ? previous.angle : team === "blue" ? 0 : Math.PI
  };
}

function playerNumber(id: PlayerId): number {
  return Number(id.slice(1)) || 0;
}

function blueprintOrigin(walls: Wall[]): Vec2 {
  return walls.reduce(
    (origin, wall) => ({
      x: Math.min(origin.x, wall.a.x, wall.b.x, wall.hinge?.x ?? Number.POSITIVE_INFINITY, wall.closedA?.x ?? Number.POSITIVE_INFINITY, wall.closedB?.x ?? Number.POSITIVE_INFINITY),
      y: Math.min(origin.y, wall.a.y, wall.b.y, wall.hinge?.y ?? Number.POSITIVE_INFINITY, wall.closedA?.y ?? Number.POSITIVE_INFINITY, wall.closedB?.y ?? Number.POSITIVE_INFINITY)
    }),
    { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY }
  );
}

function loadBlueprints(): Blueprint[] {
  try {
    const raw = window.localStorage.getItem(blueprintStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Blueprint[];
    return Array.isArray(parsed) ? parsed.map((blueprint) => ({ ...blueprint, walls: blueprint.walls.map(normalizeWallKind) })) : [];
  } catch {
    return [];
  }
}

function saveBlueprints(blueprints: Blueprint[]): void {
  window.localStorage.setItem(blueprintStorageKey, JSON.stringify(blueprints));
}

function toolToPreset(tool: Tool): SegmentPresetId {
  if (tool === "window") return "window";
  if (tool === "mesh") return "mesh";
  if (tool === "breakable-wall") return "breakable-wall";
  if (tool === "door") return "door";
  return "wall";
}

function normalizedPreset(wall: Wall): SegmentPresetId {
  return normalizeWallKind(wall).preset ?? "wall";
}

function presetLabel(preset: SegmentPresetId): string {
  if (preset === "window") return "window";
  if (preset === "mesh") return "mesh";
  if (preset === "door") return "door";
  if (preset === "breakable-wall") return "breakable wall";
  if (preset === "deployable-wall") return "deployable";
  return "wall";
}

function nextId(prefix: string, items: Array<{ id: string }>): string {
  let index = items.length + 1;
  while (items.some((item) => item.id === `${prefix}-${index}` || item.id.startsWith(`${prefix}-${index}-`))) index += 1;
  return `${prefix}-${index}`;
}

function clearLabels(labels: Phaser.GameObjects.Text[]): void {
  for (const label of labels) label.destroy();
}

function numberField(field: string, value: number): string {
  return `<label>${field} <input type="number" step="1" data-field="${field}" data-map-field="${field}" value="${value}"></label>`;
}

function checkField(field: string, value: boolean): string {
  return `<button type="button" class="check-row checkbox-button" data-checkbox-field="${field}" aria-pressed="${value ? "true" : "false"}"><span>${field}</span><input type="checkbox" data-field="${field}" ${value ? "checked" : ""} tabindex="-1"></button>`;
}

function selectField(field: string, value: string, options: string[]): string {
  return `<label>${field} <select data-field="${field}">${options.map((option) => `<option value="${option}" ${option === value ? "selected" : ""}>${option}</option>`).join("")}</select></label>`;
}

function onEditorControlCommit(input: HTMLInputElement | HTMLSelectElement, handler: () => void): void {
  if (input instanceof HTMLInputElement && input.type === "checkbox") {
    const button = input.closest<HTMLButtonElement>("[data-checkbox-field]");
    if (button) {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        input.checked = !input.checked;
        button.setAttribute("aria-pressed", input.checked ? "true" : "false");
        handler();
      });
      return;
    }
    input.addEventListener("change", handler);
    return;
  }
  input.addEventListener("input", handler);
}

function applyWallField(wall: Wall, field: string, raw: string | boolean): void {
  const value = typeof raw === "boolean" ? raw : Number.isFinite(Number(raw)) && raw.trim() !== "" ? Number(raw) : raw;
  if (field === "preset") {
    Object.assign(wall, applySegmentPreset(wall, value as SegmentPresetId));
    wall.label = presetLabel(value as SegmentPresetId);
    return;
  }
  if (field === "destructible") {
    wall.destructible = Boolean(value);
    if (wall.destructible) {
      wall.maxHp = wall.maxHp ?? defaultDestructibleHp(wall);
      wall.hp = wall.maxHp;
    } else {
      delete wall.maxHp;
      delete wall.hp;
    }
    return;
  }
  if (field === "maxHp") {
    wall.maxHp = Math.max(1, Math.floor(Number(value) || defaultDestructibleHp(wall)));
    wall.hp = wall.maxHp;
    wall.destructible = true;
    return;
  }
  const parts = field.split(".");
  if (parts.length === 1) {
    (wall as unknown as Record<string, string | number | boolean>)[field] = value as string | number | boolean;
    return;
  }
  const [parent, child] = parts;
  if (!parent || !child) return;
  const nested = (wall as unknown as Record<string, Record<string, number>>)[parent];
  if (nested) nested[child] = Number(value);
}

function defaultDestructibleHp(wall: Wall | undefined): number {
  if (!wall) return 5;
  const preset = normalizedPreset(wall);
  if (preset === "window" || preset === "mesh") return 1;
  if (preset === "deployable-wall") return 8;
  return 5;
}

function applySpawnField(spawn: Spawn, field: string, raw: string | boolean): void {
  const value = typeof raw === "boolean" ? raw : Number.isFinite(Number(raw)) && raw.trim() !== "" ? Number(raw) : raw;
  const parts = field.split(".");
  if (parts.length === 1) {
    (spawn as unknown as Record<string, string | number | boolean>)[field] = value as string | number | boolean;
    return;
  }
  const [parent, child] = parts;
  if (!parent || !child) return;
  const nested = (spawn as unknown as Record<string, Record<string, number>>)[parent];
  if (nested) nested[child] = Number(value);
}

function drawDashedLine(g: Phaser.GameObjects.Graphics, a: Vec2, b: Vec2, dashLength: number, gapLength: number): void {
  const total = distance(a, b);
  if (total <= 0) return;
  const direction = { x: (b.x - a.x) / total, y: (b.y - a.y) / total };
  for (let offset = 0; offset < total; offset += dashLength + gapLength) {
    const start = Math.min(offset, total);
    const end = Math.min(offset + dashLength, total);
    g.lineBetween(a.x + direction.x * start, a.y + direction.y * start, a.x + direction.x * end, a.y + direction.y * end);
  }
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}
