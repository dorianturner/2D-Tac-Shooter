import { add, distance, distanceToSegment, lineIntersection, mul, normalize, sub } from "./geometry.js";
import type { MapDefinition, SegmentPresetId, Vec2, Wall, WallKind } from "./types.js";

type SegmentPresetDefaults = {
  preset: SegmentPresetId;
  kind: WallKind;
  label: string;
  thickness: number;
  blocksVision: boolean;
  blocksMovement: boolean;
  blocksShooting: boolean;
  destructible: boolean;
};

export const segmentPresetDefaults: Record<SegmentPresetId, SegmentPresetDefaults> = {
  wall: { preset: "wall", kind: "solid", label: "wall", thickness: 12, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: false },
  window: { preset: "window", kind: "transparent", label: "window", thickness: 12, blocksVision: false, blocksMovement: true, blocksShooting: true, destructible: false },
  mesh: { preset: "mesh", kind: "mesh", label: "mesh", thickness: 5, blocksVision: false, blocksMovement: true, blocksShooting: false, destructible: false },
  "breakable-wall": { preset: "breakable-wall", kind: "solid", label: "breakable wall", thickness: 12, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: true },
  door: { preset: "door", kind: "door", label: "door", thickness: 6, blocksVision: false, blocksMovement: false, blocksShooting: true, destructible: false },
  "deployable-wall": { preset: "deployable-wall", kind: "solid", label: "deployable", thickness: 10, blocksVision: true, blocksMovement: true, blocksShooting: true, destructible: true }
};

export function presetFromLegacyKind(kind?: string, destructible = false): SegmentPresetId {
  if (kind === "destructible") return "breakable-wall";
  if (kind === "door") return "door";
  if (kind === "mesh") return "mesh";
  if (kind === "transparent") return "window";
  if (destructible) return "breakable-wall";
  return "wall";
}

export function segmentPreset(wall: Wall): SegmentPresetId {
  return wall.preset ?? presetFromLegacyKind((wall as unknown as { kind?: string }).kind, wall.destructible);
}

export function wallKindDefaults(kind: WallKind): Pick<Wall, "preset" | "kind" | "blocksVision" | "blocksMovement" | "blocksShooting" | "destructible"> {
  const preset = presetFromLegacyKind(kind);
  const defaults = segmentPresetDefaults[preset];
  return {
    preset: defaults.preset,
    kind,
    blocksVision: defaults.blocksVision,
    blocksMovement: defaults.blocksMovement,
    blocksShooting: defaults.blocksShooting,
    destructible: defaults.destructible
  };
}

export function createWall(id: string, kind: WallKind, a: Vec2, b: Vec2, thickness = 12, extra: Partial<Wall> = {}): Wall {
  const preset = extra.preset ?? presetFromLegacyKind(kind, extra.destructible);
  return createSegmentFromPreset(id, preset, a, b, { kind, thickness, ...extra });
}

export function createSegmentFromPreset(id: string, preset: SegmentPresetId, a: Vec2, b: Vec2, extra: Partial<Wall> = {}): Wall {
  const defaults = segmentPresetDefaults[preset];
  return {
    id,
    ...defaults,
    a,
    b,
    thickness: extra.thickness ?? defaults.thickness,
    ...extra
  };
}

export function applySegmentPreset(wall: Wall, preset: SegmentPresetId): Wall {
  const defaults = segmentPresetDefaults[preset];
  return {
    ...wall,
    ...defaults,
    preset,
    thickness: wall.thickness
  };
}

export function normalizeSegment(wall: Wall): Wall {
  const legacyKind = (wall as unknown as { kind?: string }).kind;
  const preset = wall.preset ?? presetFromLegacyKind(legacyKind, wall.destructible);
  const defaults = segmentPresetDefaults[preset];
  if (legacyKind === "destructible") {
    const normalized: Wall = { ...wall, ...defaults, preset: "breakable-wall", kind: "solid", destructible: true, blocksShooting: wall.blocksShooting ?? defaults.blocksShooting };
    if (wall.label === "destructible") normalized.label = "wall";
    return normalized;
  }
  const kind = legacyKind === "transparent" || legacyKind === "door" || legacyKind === "mesh" || legacyKind === "solid" ? legacyKind : defaults.kind;
  return {
    ...wall,
    preset,
    kind,
    label: wall.label ?? defaults.label,
    blocksVision: wall.blocksVision ?? defaults.blocksVision,
    blocksMovement: wall.blocksMovement ?? defaults.blocksMovement,
    blocksShooting: wall.blocksShooting ?? defaults.blocksShooting,
    destructible: wall.destructible ?? defaults.destructible
  };
}

export function normalizeWallKind(wall: Wall): Wall {
  return normalizeSegment(wall);
}

export function normalizeMapDefinition(map: MapDefinition): MapDefinition {
  const objectives = normalizeObjectives(map);
  return {
    ...map,
    ...(objectives.length > 0 ? { objectives, objective: objectives[0]! } : {}),
    walls: map.walls.map(normalizeSegment)
  };
}

export function mapObjectives(map: MapDefinition): NonNullable<MapDefinition["objectives"]> {
  return normalizeObjectives(map);
}

function normalizeObjectives(map: MapDefinition): NonNullable<MapDefinition["objectives"]> {
  const source = map.objectives && map.objectives.length > 0 ? map.objectives : map.objective ? [map.objective] : [];
  return source.map((objective, index) => ({
    id: objective.id || `objective-${index + 1}`,
    position: { ...objective.position },
    radius: objective.radius || 56
  }));
}

export function isHingedDoorSegment(wall: Wall): boolean {
  return segmentPreset(wall) === "door" || Boolean(wall.hinge && wall.closedB);
}

export function segmentBlocksMovement(wall: Wall): boolean {
  return !wall.destroyed && wall.blocksMovement;
}

export function segmentBlocksVision(wall: Wall): boolean {
  return !wall.destroyed && wall.blocksVision;
}

export function segmentBlocksShooting(wall: Wall): boolean {
  return !wall.destroyed && wall.blocksShooting;
}

export function isShootableDestructibleSegment(wall: Wall): boolean {
  return !wall.destroyed && wall.destructible && !isHingedDoorSegment(wall);
}

export function deleteWallsById(walls: Wall[], ids: Set<string>): Wall[] {
  return walls.filter((wall) => !ids.has(wall.id));
}

export function nearestPointOnWall(wall: Wall, point: Vec2): Vec2 {
  const ab = sub(wall.b, wall.a);
  const lengthSquared = ab.x * ab.x + ab.y * ab.y;
  if (lengthSquared <= 0) return { ...wall.a };
  const t = Math.max(0, Math.min(1, ((point.x - wall.a.x) * ab.x + (point.y - wall.a.y) * ab.y) / lengthSquared));
  return add(wall.a, mul(ab, t));
}

export function insertDoorGap(walls: Wall[], wallId: string, point: Vec2, width: number, idPrefix: string): Wall[] {
  const wall = walls.find((candidate) => candidate.id === wallId);
  if (!wall || isHingedDoorSegment(wall)) return walls;
  const hit = nearestPointOnWall(wall, point);
  const direction = normalize(sub(wall.b, wall.a));
  const half = width / 2;
  const gapA = add(hit, mul(direction, -half));
  const gapB = add(hit, mul(direction, half));
  const minimumSegment = Math.max(8, wall.thickness);
  const leftLength = distance(wall.a, gapA);
  const rightLength = distance(gapB, wall.b);
  const next: Wall[] = walls.filter((candidate) => candidate.id !== wallId);
  if (leftLength > minimumSegment) next.push({ ...wall, id: `${idPrefix}-left`, b: gapA });
  if (rightLength > minimumSegment) next.push({ ...wall, id: `${idPrefix}-right`, a: gapB });
  next.push(createSegmentFromPreset(`${idPrefix}-door`, "door", gapA, gapB, { thickness: Math.max(4, wall.thickness / 2), label: "DOOR" }));
  return next;
}

export interface DoorSwingValidation {
  valid: boolean;
  blockerId?: string;
}

export function validateDoorSwing(walls: Wall[], door: Wall, maxAngle = 1.92): DoorSwingValidation {
  if (!isHingedDoorSegment(door)) return { valid: true };
  const hinge = door.hinge ?? door.closedA ?? door.a;
  const closedB = door.closedB ?? door.b;
  const doorHalf = door.thickness / 2;
  const angles = [-maxAngle, -1.4, -1, -0.6, -0.25, 0.25, 0.6, 1, 1.4, maxAngle];

  for (const wall of walls) {
    if (wall.id === door.id || !segmentBlocksMovement(wall)) continue;
    if (wallSharesDoorFramePoint(hinge, closedB, doorHalf, wall)) continue;
    for (const angle of angles) {
      const swungB = rotateDoorEndpoint(hinge, closedB, angle);
      if (segmentsOverlapWithThickness(hinge, swungB, wall.a, wall.b, doorHalf + wall.thickness / 2)) return { valid: false, blockerId: wall.id };
    }
  }

  return { valid: true };
}

export function wallIntersectsRect(wall: Wall, min: Vec2, max: Vec2): boolean {
  if (pointInRect(wall.a, min, max) || pointInRect(wall.b, min, max)) return true;
  const center = { x: (wall.a.x + wall.b.x) / 2, y: (wall.a.y + wall.b.y) / 2 };
  return pointInRect(center, min, max) || distanceToSegment(min, wall.a, wall.b) <= wall.thickness || distanceToSegment(max, wall.a, wall.b) <= wall.thickness;
}

export function slugifyMapName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || "untitled-map";
}

export function replaceWallSection(walls: Wall[], replacement: Wall): Wall[] {
  const axis = dominantAxis(replacement);
  const start = axisValue(replacement.a, axis);
  const end = axisValue(replacement.b, axis);
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  const result: Wall[] = [];
  let replaced = false;

  for (const wall of walls) {
    if (isHingedDoorSegment(wall) || !isReplaceableOverlap(wall, replacement, axis, min, max)) {
      result.push(wall);
      continue;
    }
    replaced = true;
    const wallStart = axisValue(wall.a, axis);
    const wallEnd = axisValue(wall.b, axis);
    const wallMin = Math.min(wallStart, wallEnd);
    const wallMax = Math.max(wallStart, wallEnd);
    const overlapMin = Math.max(wallMin, min);
    const overlapMax = Math.min(wallMax, max);
    const minimumSegment = Math.max(8, wall.thickness);

    const before = segmentFromRange(wall, axis, wallMin, overlapMin, `${wall.id}-before`);
    if (before && distance(before.a, before.b) >= minimumSegment) result.push(before);
    const after = segmentFromRange(wall, axis, overlapMax, wallMax, `${wall.id}-after`);
    if (after && distance(after.a, after.b) >= minimumSegment) result.push(after);
  }

  result.push(replacement);
  return replaced ? result : [...walls, replacement];
}

function isReplaceableOverlap(wall: Wall, replacement: Wall, axis: "x" | "y", min: number, max: number): boolean {
  if (segmentPreset(wall) !== "wall") return false;
  if (!wall.blocksMovement || !wall.blocksVision || !wall.blocksShooting || wall.destructible) return false;
  if (dominantAxis(wall) !== axis) return false;
  const crossAxis: "x" | "y" = axis === "x" ? "y" : "x";
  const crossDelta = Math.max(
    Math.abs(axisValue(wall.a, crossAxis) - axisValue(replacement.a, crossAxis)),
    Math.abs(axisValue(wall.b, crossAxis) - axisValue(replacement.b, crossAxis))
  );
  if (crossDelta > Math.max(10, wall.thickness)) return false;
  const wallMin = Math.min(axisValue(wall.a, axis), axisValue(wall.b, axis));
  const wallMax = Math.max(axisValue(wall.a, axis), axisValue(wall.b, axis));
  return Math.max(wallMin, min) < Math.min(wallMax, max);
}

function dominantAxis(wall: Wall): "x" | "y" {
  return Math.abs(wall.b.x - wall.a.x) >= Math.abs(wall.b.y - wall.a.y) ? "x" : "y";
}

function axisValue(point: Vec2, axis: "x" | "y"): number {
  return axis === "x" ? point.x : point.y;
}

function segmentFromRange(wall: Wall, axis: "x" | "y", min: number, max: number, id: string): Wall | null {
  if (max <= min) return null;
  const reverse = axisValue(wall.a, axis) > axisValue(wall.b, axis);
  const aValue = reverse ? max : min;
  const bValue = reverse ? min : max;
  const crossAxis: "x" | "y" = axis === "x" ? "y" : "x";
  const cross = (axisValue(wall.a, crossAxis) + axisValue(wall.b, crossAxis)) / 2;
  const a = axis === "x" ? { x: aValue, y: cross } : { x: cross, y: aValue };
  const b = axis === "x" ? { x: bValue, y: cross } : { x: cross, y: bValue };
  return { ...wall, id, a, b };
}

function pointInRect(point: Vec2, min: Vec2, max: Vec2): boolean {
  return point.x >= min.x && point.x <= max.x && point.y >= min.y && point.y <= max.y;
}

function rotateDoorEndpoint(hinge: Vec2, closedB: Vec2, angle: number): Vec2 {
  const length = distance(hinge, closedB);
  const base = Math.atan2(closedB.y - hinge.y, closedB.x - hinge.x);
  return { x: hinge.x + Math.cos(base + angle) * length, y: hinge.y + Math.sin(base + angle) * length };
}

function wallSharesDoorFramePoint(hinge: Vec2, closedB: Vec2, doorHalf: number, wall: Wall): boolean {
  const tolerance = doorHalf + wall.thickness / 2 + 2;
  return [wall.a, wall.b].some((point) => distance(point, hinge) <= tolerance || distance(point, closedB) <= tolerance);
}

function segmentsOverlapWithThickness(a: Vec2, b: Vec2, c: Vec2, d: Vec2, threshold: number): boolean {
  if (lineIntersection(a, b, c, d)) return true;
  return distanceToSegment(a, c, d) < threshold || distanceToSegment(b, c, d) < threshold || distanceToSegment(c, a, b) < threshold || distanceToSegment(d, a, b) < threshold;
}
