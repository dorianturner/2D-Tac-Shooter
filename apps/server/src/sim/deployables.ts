import { add, angleToVector, distance, distanceToSegment, lineIntersection, mul, normalize, type MapDefinition, type Vec2, type Wall } from "@tac/shared";
import { DEPLOYABLE_WALL_HP, DEPLOYABLE_WALL_LENGTH, DEPLOYABLE_WALL_THICKNESS, PLAYER_RADIUS } from "./config.js";

export interface ThrownTarget {
  position: Vec2;
  valid: boolean;
  blocked: boolean;
  firstImpact?: Vec2;
  bounceStart?: Vec2;
  bounceEnd?: Vec2;
}

export function clampTarget(map: MapDefinition, origin: Vec2, target: Vec2, maxRange: number): Vec2 {
  const delta = { x: target.x - origin.x, y: target.y - origin.y };
  const length = Math.hypot(delta.x, delta.y);
  if (length <= 0.0001) return { ...origin };
  const direction = { x: delta.x / length, y: delta.y / length };
  const rangeDistance = Math.min(length, maxRange);
  const boundsDistance = distanceToInsetBounds(map, origin, direction);
  return add(origin, mul(direction, Math.max(0, Math.min(rangeDistance, boundsDistance))));
}

export function resolveThrownTarget(map: MapDefinition, origin: Vec2, target: Vec2, maxRange: number): ThrownTarget {
  const clamped = clampTarget(map, origin, target, maxRange);
  if (distance(origin, clamped) < PLAYER_RADIUS * 0.6) return { position: clamped, blocked: false, valid: false };
  const direction = normalize({ x: clamped.x - origin.x, y: clamped.y - origin.y });
  const maxDistance = distance(origin, clamped);
  const firstHit = firstThrowHit(map, origin, clamped);
  if (!firstHit) return { position: clamped, blocked: false, valid: true };

  const reflected = reflect(direction, firstHit.wall);
  const remaining = Math.max(0, maxDistance - firstHit.distance);
  const bounceStart = add(firstHit.point, mul(reflected, Math.max(PLAYER_RADIUS, firstHit.wall.thickness / 2 + 2)));
  const bounceTarget = clampTarget(map, bounceStart, add(bounceStart, mul(reflected, remaining)), remaining);
  const secondHit = firstThrowHit(map, bounceStart, bounceTarget, firstHit.wall.id);
  const position = secondHit
    ? add(secondHit.point, mul(reflected, -Math.max(PLAYER_RADIUS, secondHit.wall.thickness / 2 + 2)))
    : bounceTarget;
  return {
    position,
    blocked: true,
    valid: distance(origin, position) >= PLAYER_RADIUS * 0.6,
    firstImpact: firstHit.point,
    bounceStart,
    bounceEnd: position
  };
}

export function isPlacementClear(map: MapDefinition, position: Vec2, radius = PLAYER_RADIUS): boolean {
  return !map.walls.some((wall) => !wall.destroyed && wall.blocksMovement && distanceToSegment(position, wall.a, wall.b) < radius + wall.thickness / 2);
}

export function hasPlacementLineOfSight(map: MapDefinition, origin: Vec2, target: Vec2): boolean {
  return !map.walls.some((wall) => !wall.destroyed && placementBlockingWall(wall) && lineIntersection(origin, target, wall.a, wall.b));
}

export function createDeployableWall(id: string, center: Vec2, angle: number): Wall {
  const direction = angleToVector(angle);
  const half = DEPLOYABLE_WALL_LENGTH / 2;
  return {
    id,
    kind: "solid",
    label: "DEPLOYABLE",
    a: add(center, mul(direction, -half)),
    b: add(center, mul(direction, half)),
    thickness: DEPLOYABLE_WALL_THICKNESS,
    blocksVision: true,
    blocksMovement: true,
    destructible: true,
    hp: DEPLOYABLE_WALL_HP,
    maxHp: DEPLOYABLE_WALL_HP
  };
}

function throwBlockingWall(wall: Wall): boolean {
  return wall.kind === "door" || wall.kind === "solid" || wall.blocksVision;
}

function placementBlockingWall(wall: Wall): boolean {
  if (wall.kind === "mesh") return false;
  return wall.kind === "door" || wall.kind === "transparent" || wall.blocksVision || wall.kind === "solid";
}

function firstThrowHit(map: MapDefinition, from: Vec2, to: Vec2, ignoreWallId?: string): { wall: Wall; point: Vec2; distance: number } | null {
  let nearest: { wall: Wall; point: Vec2; distance: number } | null = null;
  for (const wall of map.walls) {
    if (wall.id === ignoreWallId || wall.destroyed || !throwBlockingWall(wall)) continue;
    const hit = lineIntersection(from, to, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(from, hit);
    if (!nearest || hitDistance < nearest.distance) nearest = { wall, point: hit, distance: hitDistance };
  }
  return nearest;
}

function reflect(direction: Vec2, wall: Wall): Vec2 {
  const wallDirection = normalize({ x: wall.b.x - wall.a.x, y: wall.b.y - wall.a.y });
  const normal = { x: -wallDirection.y, y: wallDirection.x };
  const dot = direction.x * normal.x + direction.y * normal.y;
  return normalize({ x: direction.x - 2 * dot * normal.x, y: direction.y - 2 * dot * normal.y });
}

function distanceToInsetBounds(map: MapDefinition, origin: Vec2, direction: Vec2): number {
  const minX = PLAYER_RADIUS;
  const minY = PLAYER_RADIUS;
  const maxX = map.bounds.width - PLAYER_RADIUS;
  const maxY = map.bounds.height - PLAYER_RADIUS;
  let limit = Number.POSITIVE_INFINITY;
  if (direction.x > 0) limit = Math.min(limit, (maxX - origin.x) / direction.x);
  if (direction.x < 0) limit = Math.min(limit, (minX - origin.x) / direction.x);
  if (direction.y > 0) limit = Math.min(limit, (maxY - origin.y) / direction.y);
  if (direction.y < 0) limit = Math.min(limit, (minY - origin.y) / direction.y);
  return Number.isFinite(limit) ? Math.max(0, limit) : 0;
}
