import Phaser from "phaser";
import {
  add,
  createWall,
  deleteWallsById,
  distance,
  distanceToSegment,
  insertDoorGap,
  replaceWallSection,
  slugifyMapName,
  sub,
  validateDoorSwing,
  wallIntersectsRect,
  wallKindDefaults,
  type MapDefinition,
  type PlayerId,
  type Spawn,
  type Vec2,
  type Wall,
  type WallKind
} from "@tac/shared";
import { listMaps, loadMap, saveMap } from "../editorApi";
import { mapSummaryToPickable, pickFromList } from "../fuzzyPicker";
import { colors } from "../render";

type Tool = "select" | "wall" | "transparent" | "mesh" | "door" | "room" | "p1-spawn" | "p2-spawn";
type DragMode =
  | { type: "none" }
  | { type: "pan"; previous: Vec2 }
  | { type: "create"; start: Vec2 }
  | { type: "select-box"; start: Vec2; current: Vec2 }
  | { type: "move"; previous: Vec2 }
  | { type: "spawn"; id: PlayerId }
  | { type: "endpoint"; wallId: string; endpoint: "a" | "b" };

const tools: Array<{ id: Tool; label: string }> = [
  { id: "select", label: "Select" },
  { id: "wall", label: "Wall" },
  { id: "transparent", label: "Transparent" },
  { id: "mesh", label: "Mesh" },
  { id: "door", label: "Door" },
  { id: "room", label: "Room" },
  { id: "p1-spawn", label: "P1 Spawn" },
  { id: "p2-spawn", label: "P2 Spawn" }
];

const defaultDoorWidth = 64;

export class EditorScene extends Phaser.Scene {
  private map: MapDefinition = createBlankMap();
  private base: Phaser.GameObjects.Graphics | undefined = undefined;
  private overlay: Phaser.GameObjects.Graphics | undefined = undefined;
  private labels: Phaser.GameObjects.Text[] = [];
  private tool: Tool = "select";
  private selectedIds = new Set<string>();
  private selectedSpawns = new Set<PlayerId>();
  private drag: DragMode = { type: "none" };
  private pointerWorld: Vec2 = { x: 0, y: 0 };
  private snap = true;
  private doorWidth = defaultDoorWidth;
  private undoStack: MapDefinition[] = [];
  private clipboard: { walls: Wall[]; spawns: Spawn[] } | undefined = undefined;
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
        <p class="editor-hint">Wheel zooms. Middle-drag pans. Shift-click adds to selection. Drag empty space to box-select. Delete removes selected geometry.</p>
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
    if (isMiddleMouse(pointer.event)) {
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
    if (this.tool === "wall" || this.tool === "transparent" || this.tool === "mesh" || this.tool === "room") {
      this.drag = { type: "create", start: point };
      return;
    }

    const spawn = this.pickSpawn(point);
    if (spawn) {
      this.recordUndo();
      this.selectedIds.clear();
      this.selectedSpawns = new Set([spawn.id]);
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
      this.drag = { type: "endpoint", wallId: handle.wallId, endpoint: handle.endpoint };
      this.renderChrome();
      this.redraw();
      return;
    }

    const picked = this.pickWall(point);
    if (picked) {
      this.recordUndo();
      this.updateSelection(picked, pointer.event.shiftKey);
      this.drag = { type: "move", previous: point };
    } else {
      if (!pointer.event.shiftKey) this.selectedIds.clear();
      if (!pointer.event.shiftKey) this.selectedSpawns.clear();
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
      else this.createSegment(this.drag.start, point, toolToKind(this.tool));
    } else if (this.drag.type === "select-box") {
      this.selectWallsInRect(this.drag.start, this.drag.current, pointer.event.shiftKey);
    }
    this.drag = { type: "none" };
    this.renderChrome();
    this.redraw();
  }

  private createSegment(a: Vec2, b: Vec2, kind: WallKind): void {
    if (distance(a, b) < 8) return;
    const wall = createWall(nextId(kind, this.map.walls), kind, a, b, 12, { label: kindLabel(kind) });
    this.map.walls = kind === "transparent" || kind === "mesh" ? replaceWallSection(this.map.walls, wall) : [...this.map.walls, wall];
    this.selectedIds = new Set([wall.id]);
    this.selectedSpawns.clear();
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
      createWall(`${roomId}-north`, "solid", corners.nw, corners.ne, 12, { roomId, label: roomId }),
      createWall(`${roomId}-east`, "solid", corners.ne, corners.se, 12, { roomId, label: roomId }),
      createWall(`${roomId}-south`, "solid", corners.se, corners.sw, 12, { roomId, label: roomId }),
      createWall(`${roomId}-west`, "solid", corners.sw, corners.nw, 12, { roomId, label: roomId })
    ];
    this.map.walls = [...this.map.walls, ...walls];
    this.selectedIds = new Set(walls.map((wall) => wall.id));
    this.selectedSpawns.clear();
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
      this.tool = "select";
    }
    this.renderChrome();
    this.redraw();
  }

  private deleteSelected(): void {
    if (this.selectedIds.size === 0 && this.selectedSpawns.size === 0) return;
    this.recordUndo();
    this.map.walls = deleteWallsById(this.map.walls, this.selectedIds);
    this.selectedIds.clear();
    this.selectedSpawns.clear();
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
    const kind = normalizedKind(wall);
    const selected = this.selectedIds.has(wall.id);
    const color = kind === "door" ? colors.sensor : kind === "mesh" ? 0xb6f2df : kind === "transparent" ? 0x67d7ff : colors.wall;
    this.overlay!.lineStyle(selected ? wall.thickness + 7 : wall.thickness, selected ? colors.warning : color, selected ? 0.95 : kind === "transparent" ? 0.5 : 0.9);
    if (kind === "transparent" || kind === "mesh") drawDashedLine(this.overlay!, wall.a, wall.b, kind === "mesh" ? 8 : 18, kind === "mesh" ? 6 : 8);
    else this.overlay!.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
    if (wall.destructible) {
      this.overlay!.lineStyle(2, colors.destructible, 0.98);
      this.overlay!.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
    }
    this.overlay!.lineStyle(1, color, 0.8);
    this.overlay!.strokeCircle(wall.a.x, wall.a.y, selected ? 8 : 5);
    this.overlay!.strokeCircle(wall.b.x, wall.b.y, selected ? 8 : 5);
    const label = wall.label || kindLabel(kind);
    if (kind !== "solid" || wall.roomId || wall.destructible || selected) this.label((wall.a.x + wall.b.x) / 2 + 6, (wall.a.y + wall.b.y) / 2 + 6, `${label.toUpperCase()}${wall.destructible ? " / DESTRUCTIBLE" : ""}`);
  }

  private drawSpawns(): void {
    for (const spawn of this.map.spawns) {
      const selected = this.selectedSpawns.has(spawn.id);
      const color = spawn.id === "p1" ? colors.blue : colors.orange;
      this.overlay!.lineStyle(selected ? 4 : 2, selected ? colors.warning : color, 0.95);
      this.overlay!.strokeCircle(spawn.position.x, spawn.position.y, selected ? 16 : 12);
      this.overlay!.fillStyle(color, 0.85);
      this.overlay!.fillCircle(spawn.position.x, spawn.position.y, 6);
      this.label(spawn.position.x + 12, spawn.position.y - 10, `${spawn.id.toUpperCase()} SPAWN`);
    }
  }

  private drawCreationPreview(): void {
    if (this.drag.type !== "create") return;
    const kind = toolToKind(this.tool);
    this.overlay!.lineStyle(2, colors.sensor, 0.9);
    if (this.tool === "room") {
      const min = { x: Math.min(this.drag.start.x, this.pointerWorld.x), y: Math.min(this.drag.start.y, this.pointerWorld.y) };
      const width = Math.abs(this.drag.start.x - this.pointerWorld.x);
      const height = Math.abs(this.drag.start.y - this.pointerWorld.y);
      this.overlay!.strokeRect(min.x, min.y, width, height);
    } else {
      this.overlay!.lineBetween(this.drag.start.x, this.drag.start.y, this.pointerWorld.x, this.pointerWorld.y);
      this.label(this.pointerWorld.x + 8, this.pointerWorld.y + 8, kindLabel(kind));
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
    this.renderMapProperties();
    this.renderSelectionProperties();
  }

  private renderMapProperties(): void {
    const container = this.root?.querySelector<HTMLElement>(".map-properties");
    if (!container) return;
    container.innerHTML = `
      <label>Name <input data-map-field="name" value="${escapeAttr(this.map.name)}"></label>
      ${numberField("bounds.width", this.map.bounds.width)}
      ${numberField("bounds.height", this.map.bounds.height)}
      ${numberField("gridSize", this.map.gridSize ?? 40)}
      ${numberField("doorWidth", this.doorWidth)}
      <label class="check-row">snap to grid <input type="checkbox" data-map-field="snap" ${this.snap ? "checked" : ""}></label>
    `;
    container.querySelectorAll<HTMLInputElement>("[data-map-field]").forEach((input) => {
      input.addEventListener("input", () => this.applyMapField(input));
    });
  }

  private renderSelectionProperties(): void {
    if (!this.properties) return;
    const selected = this.map.walls.filter((wall) => this.selectedIds.has(wall.id));
    const selectedSpawn = this.map.spawns.find((spawn) => this.selectedSpawns.has(spawn.id));
    if (selectedSpawn) {
      this.properties.innerHTML = `
        <p>${selectedSpawn.id.toUpperCase()} spawn</p>
        ${selectField("team", selectedSpawn.team, ["blue", "orange"])}
        ${numberField("position.x", selectedSpawn.position.x)}
        ${numberField("position.y", selectedSpawn.position.y)}
        ${numberField("angle", selectedSpawn.angle)}
      `;
      this.properties.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
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
        ${selectField("kind", "solid", ["solid", "transparent", "mesh", "door"])}
        ${numberField("thickness", selected[0]?.thickness ?? 12)}
        ${checkField("destructible", selected.every((wall) => wall.destructible))}
        ${checkField("blocksVision", selected.every((wall) => wall.blocksVision))}
        ${checkField("blocksMovement", selected.every((wall) => wall.blocksMovement))}
      `;
      this.properties.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
        input.addEventListener("input", () => {
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
      ${selectField("kind", normalizedKind(wall), ["solid", "transparent", "mesh", "door"])}
      ${numberField("a.x", wall.a.x)}
      ${numberField("a.y", wall.a.y)}
      ${numberField("b.x", wall.b.x)}
      ${numberField("b.y", wall.b.y)}
      ${numberField("thickness", wall.thickness)}
      ${checkField("destructible", wall.destructible)}
      ${checkField("blocksVision", wall.blocksVision)}
      ${checkField("blocksMovement", wall.blocksMovement)}
    `;
    this.properties.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((input) => {
      input.addEventListener("input", () => {
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
    else if (field === "doorWidth") this.doorWidth = Math.max(8, Number(input.value) || defaultDoorWidth);
    else if (field === "bounds.width") this.map.bounds.width = Math.max(80, Number(input.value) || this.map.bounds.width);
    else if (field === "bounds.height") this.map.bounds.height = Math.max(80, Number(input.value) || this.map.bounds.height);
    this.redraw();
  }

  private updateSelection(wall: Wall, additive: boolean): void {
    const ids = wall.roomId ? this.map.walls.filter((candidate) => candidate.roomId === wall.roomId).map((candidate) => candidate.id) : [wall.id];
    if (!additive) this.selectedIds.clear();
    if (!additive) this.selectedSpawns.clear();
    for (const id of ids) {
      if (additive && this.selectedIds.has(id)) this.selectedIds.delete(id);
      else this.selectedIds.add(id);
    }
  }

  private selectWallsInRect(a: Vec2, b: Vec2, additive: boolean): void {
    const min = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) };
    const max = { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
    if (!additive) this.selectedIds.clear();
    if (!additive) this.selectedSpawns.clear();
    for (const wall of this.map.walls) {
      if (wallIntersectsRect(wall, min, max)) this.selectedIds.add(wall.id);
    }
  }

  private pickSpawn(point: Vec2): Spawn | undefined {
    return [...this.map.spawns].reverse().find((spawn) => distance(point, spawn.position) <= 18);
  }

  private pickWall(point: Vec2, includeDoor = false): Wall | undefined {
    return [...this.map.walls]
      .reverse()
      .find((wall) => (includeDoor || normalizedKind(wall) !== "door") && distanceToSegment(point, wall.a, wall.b) <= Math.max(12, wall.thickness + 6));
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
    for (const copied of this.clipboard.walls) {
      const wall = structuredClone(copied);
      wall.id = nextId(wall.kind ?? "wall", this.map.walls);
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
    notes: map.notes ?? "",
    walls: map.walls.map((wall) => {
      const kind = wall.kind ?? (wall.blocksVision ? "solid" : "transparent");
      const defaults = wallKindDefaults(kind);
      return { ...wall, ...defaults, kind, destructible: wall.destructible };
    })
  };
}

function isMiddleMouse(event: MouseEvent | TouchEvent | WheelEvent): event is MouseEvent {
  return "button" in event && event.button === 1;
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

function toolToKind(tool: Tool): WallKind {
  if (tool === "transparent") return "transparent";
  if (tool === "mesh") return "mesh";
  if (tool === "door") return "door";
  return "solid";
}

function normalizedKind(wall: Wall): WallKind {
  return wall.kind ?? (wall.blocksVision ? "solid" : "transparent");
}

function kindLabel(kind: WallKind): string {
  if (kind === "transparent") return "transparent";
  if (kind === "mesh") return "mesh";
  if (kind === "door") return "door";
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
  return `<label class="check-row">${field} <input type="checkbox" data-field="${field}" ${value ? "checked" : ""}></label>`;
}

function selectField(field: string, value: string, options: string[]): string {
  return `<label>${field} <select data-field="${field}">${options.map((option) => `<option value="${option}" ${option === value ? "selected" : ""}>${option}</option>`).join("")}</select></label>`;
}

function applyWallField(wall: Wall, field: string, raw: string | boolean): void {
  const value = typeof raw === "boolean" ? raw : Number.isFinite(Number(raw)) && raw.trim() !== "" ? Number(raw) : raw;
  if (field === "kind") {
    Object.assign(wall, wallKindDefaults(value as WallKind));
    wall.label = kindLabel(value as WallKind);
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
