import Phaser from "phaser";
import { mapObjectives, segmentPreset, type DeployedCamera, type Detection, type MapDefinition, type MolotovZone, type ServerSnapshot, type SmokeZone, type SoundSensorZone, type Vec2, type Wall } from "@tac/shared";

export const colors = {
  bg: 0x05070a,
  grid: 0x102836,
  wall: 0x8fb6c5,
  destructible: 0xffcc66,
  destroyed: 0x31404a,
  blue: 0x24a8ff,
  orange: 0xff6f3c,
  fog: 0x020406,
  explored: 0x23404d,
  sensor: 0x5df2b6,
  warning: 0xff4f67
};

export function drawMap(g: Phaser.GameObjects.Graphics, map: MapDefinition): void {
  g.clear();
  g.fillStyle(colors.bg, 1);
  g.fillRect(0, 0, map.bounds.width, map.bounds.height);
  g.lineStyle(1, colors.grid, 0.5);
  const gridSize = map.gridSize ?? 40;
  for (let x = 0; x <= map.bounds.width; x += gridSize) g.lineBetween(x, 0, x, map.bounds.height);
  for (let y = 0; y <= map.bounds.height; y += gridSize) g.lineBetween(0, y, map.bounds.width, y);
  for (const wall of map.walls) drawWall(g, wall);
  for (const objective of mapObjectives(map)) drawObjective(g, objective.position, objective.radius, 0);
}

export function drawObjective(g: Phaser.GameObjects.Graphics, position: Vec2, radius: number, progress = 0): void {
  g.lineStyle(2, colors.destructible, 0.76);
  g.strokeCircle(position.x, position.y, radius);
  g.fillStyle(colors.destructible, 0.08);
  g.fillCircle(position.x, position.y, radius);
  if (progress > 0) {
    g.lineStyle(4, colors.warning, 0.9);
    g.beginPath();
    g.arc(position.x, position.y, radius + 5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress), false);
    g.strokePath();
  }
  g.fillStyle(colors.destructible, 0.9);
  g.fillCircle(position.x, position.y, 5);
}

export function drawWall(g: Phaser.GameObjects.Graphics, wall: Wall): void {
  const preset = segmentPreset(wall);
  const destroyed = Boolean(wall.destroyed);
  const accentDestructible = wall.destructible && !destroyed;
  if (accentDestructible) drawDestructibleOutline(g, wall);
  
  // Handle mesh walls with X pattern
  if (preset === "mesh") {
    drawMeshWall(g, wall, destroyed ? colors.destroyed : 0xb6f2df, destroyed ? 0.18 : 0.9);
    return;
  }
  
  // Handle other wall types
  const color = destroyed ? colors.destroyed : preset === "door" ? colors.sensor : preset === "window" ? 0x67d7ff : colors.wall;
  const alpha = destroyed ? 0.18 : preset === "door" ? 0.72 : preset === "window" ? 0.48 : 0.92;
  g.lineStyle(Math.max(2, wall.thickness), color, alpha);
  g.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
  
  if (preset === "window") {
    g.lineStyle(1, color, 0.8);
    g.strokeCircle((wall.a.x + wall.b.x) / 2, (wall.a.y + wall.b.y) / 2, 7);
  }
}

function drawMeshWall(g: Phaser.GameObjects.Graphics, wall: Wall, color: number, alpha: number): void {
  g.lineStyle(Math.max(1, wall.thickness / 2), color, alpha);
  const dx = wall.b.x - wall.a.x;
  const dy = wall.b.y - wall.a.y;
  const length = Math.hypot(dx, dy);
  const offset = 8;
  if (length <= 0) return;
  const normX = dx / length;
  const normY = dy / length;
  const perpX = -normY * offset;
  const perpY = normX * offset;
  g.lineBetween(wall.a.x - perpX, wall.a.y - perpY, wall.b.x + perpX, wall.b.y + perpY);
  g.lineBetween(wall.a.x + perpX, wall.a.y + perpY, wall.b.x - perpX, wall.b.y - perpY);
}

function drawDestructibleOutline(g: Phaser.GameObjects.Graphics, wall: Wall): void {
  g.lineStyle(Math.max(2, wall.thickness + 4), colors.destructible, 0.72);
  g.lineBetween(wall.a.x, wall.a.y, wall.b.x, wall.b.y);
  g.lineStyle(1, colors.destructible, 0.95);
  g.strokeCircle(wall.a.x, wall.a.y, Math.max(5, wall.thickness / 2 + 3));
  g.strokeCircle(wall.b.x, wall.b.y, Math.max(5, wall.thickness / 2 + 3));
}

export function drawSnapshot(g: Phaser.GameObjects.Graphics, snapshot: ServerSnapshot): void {
  for (const point of snapshot.explored) {
    g.fillStyle(colors.explored, 0.08);
    g.fillCircle(point.x, point.y, 48);
  }
  g.fillStyle(0x173f4f, 0.18);
  fillPolygon(g, snapshot.visiblePolygon);
  drawPlayer(g, snapshot.self.position, snapshot.self.team === "blue" ? colors.blue : colors.orange, true, snapshot.self.aim);
  for (const player of snapshot.visiblePlayers) {
    drawPlayer(g, player.position, player.team === "blue" ? colors.blue : colors.orange, false, player.aim);
  }
  for (const detection of snapshot.detections) drawDetection(g, detection);
  for (const sensor of snapshot.map.sensors) {
    if (sensor.destroyed) continue;
    g.lineStyle(1, colors.sensor, sensor.corrupted ? 0.25 : 0.42);
    if (sensor.fov >= Math.PI * 1.9) {
      g.strokeCircle(sensor.position.x, sensor.position.y, sensor.range);
    } else {
      const start = sensor.angle - sensor.fov / 2;
      const end = sensor.angle + sensor.fov / 2;
      g.beginPath();
      g.moveTo(sensor.position.x, sensor.position.y);
      g.arc(sensor.position.x, sensor.position.y, sensor.range, start, end, false);
      g.closePath();
      g.strokePath();
    }
    g.fillStyle(colors.sensor, 0.9);
    g.fillCircle(sensor.position.x, sensor.position.y, 5);
  }
  if (snapshot.debug) {
    g.lineStyle(1, colors.warning, 0.38);
    for (const poly of Object.values(snapshot.debug.visibleByPlayer)) {
      for (let i = 0; i < poly.length; i += 4) {
        const p = poly[i];
        if (p) g.lineBetween(snapshot.self.position.x, snapshot.self.position.y, p.x, p.y);
      }
    }
  }
}

export function drawFogOfWar(g: Phaser.GameObjects.Graphics, map: MapDefinition, visiblePolygon: Vec2[], visibleCircles: ServerSnapshot["visibleCircles"] = []): void {
  if (visiblePolygon.length < 3) return;
  g.fillStyle(colors.fog, 0.58);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(map.bounds.width, 0);
  g.lineTo(map.bounds.width, map.bounds.height);
  g.lineTo(0, map.bounds.height);
  g.closePath();
  for (let i = visiblePolygon.length - 1; i >= 0; i -= 1) {
    const point = visiblePolygon[i]!;
    if (i === visiblePolygon.length - 1) g.moveTo(point.x, point.y);
    else g.lineTo(point.x, point.y);
  }
  g.closePath();
  for (const circle of visibleCircles) {
    g.moveTo(circle.position.x + circle.radius, circle.position.y);
    g.arc(circle.position.x, circle.position.y, circle.radius, 0, Math.PI * 2, true);
    g.closePath();
  }
  g.fillPath();
  g.fillStyle(0xd7f3ff, 0.18);
  fillPolygon(g, visiblePolygon);
  g.lineStyle(2, 0xd7f3ff, 0.28);
  strokePolyline(g, visiblePolygon);
  for (const circle of visibleCircles) {
    g.fillStyle(0xd7f3ff, 0.13);
    g.fillCircle(circle.position.x, circle.position.y, circle.radius);
    g.lineStyle(1, 0xd7f3ff, 0.18);
    g.strokeCircle(circle.position.x, circle.position.y, circle.radius);
  }
}

export function drawDeployedCamera(g: Phaser.GameObjects.Graphics, camera: DeployedCamera, owned: boolean): void {
  if (camera.destroyed) {
    g.lineStyle(1, colors.destroyed, 0.6);
    g.strokeCircle(camera.position.x, camera.position.y, 7);
    return;
  }
  g.lineStyle(1, colors.sensor, owned ? 0.46 : 0.28);
  g.strokeCircle(camera.position.x, camera.position.y, camera.radius);
  g.fillStyle(colors.sensor, owned ? 0.95 : 0.58);
  g.fillCircle(camera.position.x, camera.position.y, 6);
  g.lineStyle(2, colors.sensor, owned ? 0.9 : 0.45);
  g.strokeCircle(camera.position.x, camera.position.y, 9);
}

export function drawMolotovZone(g: Phaser.GameObjects.Graphics, zone: MolotovZone, tick: number): void {
  const remaining = Math.max(0, zone.expiresAtTick - tick);
  const alpha = Math.max(0.18, Math.min(0.48, remaining / 150));
  g.fillStyle(0xff6f3c, alpha);
  g.fillCircle(zone.position.x, zone.position.y, zone.radius);
  g.lineStyle(2, 0xffcc66, 0.72);
  g.strokeCircle(zone.position.x, zone.position.y, zone.radius);
}

export function drawSmokeZone(g: Phaser.GameObjects.Graphics, zone: SmokeZone, tick: number): void {
  const remaining = Math.max(0, zone.expiresAtTick - tick);
  const alpha = Math.max(0.2, Math.min(0.54, remaining / 150));
  g.fillStyle(0x66727d, alpha);
  g.fillCircle(zone.position.x, zone.position.y, zone.radius);
  g.lineStyle(2, 0xb6c3cc, 0.46);
  g.strokeCircle(zone.position.x, zone.position.y, zone.radius);
}

export function drawSoundSensorZone(g: Phaser.GameObjects.Graphics, zone: SoundSensorZone, tick: number): void {
  const triggered = (zone.triggeredUntilTick ?? 0) >= tick;
  const color = triggered ? colors.warning : colors.sensor;
  g.lineStyle(2, color, triggered ? 0.78 : 0.34);
  g.strokeCircle(zone.position.x, zone.position.y, zone.radius);
  g.fillStyle(color, triggered ? 0.12 : 0.06);
  g.fillCircle(zone.position.x, zone.position.y, zone.radius);
  g.fillStyle(color, 0.82);
  g.fillCircle(zone.position.x, zone.position.y, 5);
}

export function drawPlayer(g: Phaser.GameObjects.Graphics, position: Vec2, color: number, self: boolean, aim: number): void {
  g.fillStyle(color, self ? 1 : 0.86);
  g.fillCircle(position.x, position.y, self ? 10 : 9);
  g.lineStyle(3, color, 0.9);
  g.lineBetween(position.x, position.y, position.x + Math.cos(aim) * 24, position.y + Math.sin(aim) * 24);
}

function drawDetection(g: Phaser.GameObjects.Graphics, detection: Detection): void {
  if (detection.kind === "sound-area") {
    g.lineStyle(2, colors.warning, detection.confidence);
    g.strokeCircle(detection.position.x, detection.position.y, detection.radius ?? 80);
    g.fillStyle(colors.warning, 0.12);
    g.fillCircle(detection.position.x, detection.position.y, detection.radius ?? 80);
    return;
  }
  g.lineStyle(2, detection.kind === "motion-pulse" ? colors.warning : colors.sensor, detection.confidence);
  g.strokeCircle(detection.position.x, detection.position.y, 22 + (1 - detection.confidence) * 24);
  g.fillStyle(detection.kind === "motion-pulse" ? colors.warning : colors.sensor, 0.2);
  g.fillCircle(detection.position.x, detection.position.y, 8);
}

export function fillPolygon(g: Phaser.GameObjects.Graphics, points: Vec2[]): void {
  if (points.length < 3) return;
  g.beginPath();
  g.moveTo(points[0]!.x, points[0]!.y);
  for (const point of points.slice(1)) g.lineTo(point.x, point.y);
  g.closePath();
  g.fillPath();
}

function strokePolyline(g: Phaser.GameObjects.Graphics, points: Vec2[]): void {
  if (points.length < 2) return;
  g.beginPath();
  g.moveTo(points[0]!.x, points[0]!.y);
  for (const point of points.slice(1)) g.lineTo(point.x, point.y);
  g.strokePath();
}
