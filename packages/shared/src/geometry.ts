import type { MapDefinition, Vec2, Wall } from "./types.js";

export const TAU = Math.PI * 2;

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function mul(a: Vec2, scale: number): Vec2 {
  return { x: a.x * scale, y: a.y * scale };
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return length(sub(a, b));
}

export function normalize(a: Vec2): Vec2 {
  const len = length(a);
  return len > 0 ? { x: a.x / len, y: a.y / len } : { x: 0, y: 0 };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function angleToVector(angle: number): Vec2 {
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function normalizeAngle(angle: number): number {
  let result = angle % TAU;
  if (result < -Math.PI) result += TAU;
  if (result > Math.PI) result -= TAU;
  return result;
}

export function angleBetween(origin: Vec2, target: Vec2): number {
  return Math.atan2(target.y - origin.y, target.x - origin.x);
}

export function pointInCone(origin: Vec2, angle: number, fov: number, range: number, point: Vec2): boolean {
  if (distance(origin, point) > range) return false;
  const delta = Math.abs(normalizeAngle(angleBetween(origin, point) - angle));
  return delta <= fov / 2;
}

export function lineIntersection(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = r.x * s.y - r.y * s.x;
  if (Math.abs(denom) < 0.000001) return null;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / denom;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / denom;
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return { x: a.x + t * r.x, y: a.y + t * r.y };
  }
  return null;
}

export function activeVisionWalls(map: MapDefinition): Wall[] {
  return map.walls.filter((wall) => wall.blocksVision && !wall.destroyed);
}

export function hasLineOfSight(map: MapDefinition, from: Vec2, to: Vec2): boolean {
  return !activeVisionWalls(map).some((wall) => lineIntersection(from, to, wall.a, wall.b));
}

export function raycast(map: MapDefinition, origin: Vec2, angle: number, range: number): Vec2 {
  const end = add(origin, mul(angleToVector(angle), range));
  let closest = end;
  let closestDistance = range;
  for (const wall of activeVisionWalls(map)) {
    const hit = lineIntersection(origin, end, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (hitDistance < closestDistance) {
      closest = hit;
      closestDistance = hitDistance;
    }
  }
  return closest;
}

export function visiblePolygon(map: MapDefinition, origin: Vec2, range = 420, rays = 96): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < rays; i += 1) {
    points.push(raycast(map, origin, (i / rays) * TAU, range));
  }
  return points;
}

export function moveWithWallCollision(map: MapDefinition, current: Vec2, desired: Vec2, radius: number): Vec2 {
  const clamped = {
    x: clamp(desired.x, radius, map.bounds.width - radius),
    y: clamp(desired.y, radius, map.bounds.height - radius)
  };
  for (const wall of map.walls) {
    if (!wall.blocksMovement || wall.destroyed) continue;
    if (distanceToSegment(clamped, wall.a, wall.b) < radius + wall.thickness / 2) {
      return current;
    }
  }
  return clamped;
}

export function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const t = clamp(((point.x - a.x) * ab.x + (point.y - a.y) * ab.y) / (ab.x * ab.x + ab.y * ab.y), 0, 1);
  return distance(point, add(a, mul(ab, t)));
}
