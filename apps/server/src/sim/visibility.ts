import {
  add,
  angleToVector,
  distance,
  hasLineOfSight,
  lineIntersection,
  mul,
  pointInCone,
  type MapDefinition,
  type SmokeZone,
  type Vec2,
  type Wall
} from "@tac/shared";

export function smokeBlocksSegment(smokes: SmokeZone[], from: Vec2, to: Vec2): boolean {
  return smokes.some((smoke) => smoke.expiresAtTick >= 0 && segmentCircleDistance(from, to, smoke.position) <= smoke.radius);
}

export function hasLineOfSightWithSmoke(map: MapDefinition, smokes: SmokeZone[], from: Vec2, to: Vec2, visionWalls = map.walls): boolean {
  return !smokeBlocksSegment(smokes, from, to) && hasLineOfSightAgainstWalls(map, from, to, visionWalls);
}

export function hasConeLineOfSightWithSmoke(
  map: MapDefinition,
  smokes: SmokeZone[],
  origin: Vec2,
  angle: number,
  fov: number,
  range: number,
  point: Vec2,
  visionWalls?: Wall[]
): boolean {
  return pointInCone(origin, angle, fov, range, point) && hasLineOfSightWithSmoke(map, smokes, origin, point, visionWalls);
}

export function visibleConePolygonWithSmoke(map: MapDefinition, smokes: SmokeZone[], origin: Vec2, angle: number, fov: number, range: number, rays = 48, visionWalls = map.walls): Vec2[] {
  const points: Vec2[] = [origin];
  const start = angle - fov / 2;
  const steps = Math.max(2, rays);
  for (let index = 0; index <= steps; index += 1) {
    const rayAngle = start + (fov * index) / steps;
    points.push(raycastWithSmoke(map, smokes, origin, rayAngle, range, visionWalls));
  }
  return points;
}

function raycastWithSmoke(map: MapDefinition, smokes: SmokeZone[], origin: Vec2, angle: number, range: number, visionWalls: Wall[]): Vec2 {
  const direction = angleToVector(angle);
  const target = add(origin, mul(direction, range));
  let closest = target;
  let closestDistance = range;

  for (const wall of visionWalls) {
    const hit = lineIntersection(origin, target, wall.a, wall.b);
    if (!hit) continue;
    const hitDistance = distance(origin, hit);
    if (hitDistance < closestDistance) {
      closest = hit;
      closestDistance = hitDistance;
    }
  }

  for (const smoke of smokes) {
    const smokeDistance = rayCircleIntersectionDistance(origin, direction, smoke.position, smoke.radius, closestDistance);
    if (smokeDistance !== null && smokeDistance < closestDistance) {
      closest = add(origin, mul(direction, smokeDistance));
      closestDistance = smokeDistance;
    }
  }

  return closest;
}

function hasLineOfSightAgainstWalls(map: MapDefinition, from: Vec2, to: Vec2, visionWalls: Wall[]): boolean {
  if (visionWalls === map.walls) return hasLineOfSight(map, from, to);
  return !visionWalls.some((wall) => lineIntersection(from, to, wall.a, wall.b));
}

function rayCircleIntersectionDistance(origin: Vec2, direction: Vec2, center: Vec2, radius: number, maxDistance: number): number | null {
  const offset = { x: origin.x - center.x, y: origin.y - center.y };
  const b = offset.x * direction.x + offset.y * direction.y;
  const c = offset.x * offset.x + offset.y * offset.y - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const first = -b - root;
  const second = -b + root;
  const distance = first >= 0 ? first : second >= 0 ? second : 0;
  return distance <= maxDistance ? distance : null;
}

function segmentCircleDistance(a: Vec2, b: Vec2, center: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return distance(a, center);
  const t = Math.max(0, Math.min(1, ((center.x - a.x) * dx + (center.y - a.y) * dy) / lengthSq));
  return distance({ x: a.x + dx * t, y: a.y + dy * t }, center);
}
