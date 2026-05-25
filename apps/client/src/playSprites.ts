import Phaser from "phaser";
import { segmentPreset, type DeployedCamera, type MolotovZone, type PlayerId, type ServerSnapshot, type SmokeZone, type SoundSensorZone, type Vec2, type Wall } from "@tac/shared";
import { imageAssets, weaponSpriteAssets } from "./assets";

interface RenderedPlayer {
  position: Vec2;
  aim: number;
}

const PLAYER_SPRITE_WORLD_SIZE = 40;

export class PlaySpritePresenter {
  private readonly players = new Map<PlayerId, Phaser.GameObjects.Image>();
  private readonly weapons = new Map<PlayerId, Phaser.GameObjects.Image>();
  private readonly gadgets = new Map<string, Phaser.GameObjects.Image>();

  constructor(private readonly scene: Phaser.Scene) {}

  render(snapshot: ServerSnapshot, renderedPlayers: Map<PlayerId, RenderedPlayer>): void {
    this.renderPlayers(snapshot, renderedPlayers);
    this.renderGadgets(snapshot);
  }

  clear(): void {
    clearImageMap(this.players);
    clearImageMap(this.weapons);
    clearImageMap(this.gadgets);
  }

  private renderPlayers(snapshot: ServerSnapshot, renderedPlayers: Map<PlayerId, RenderedPlayer>): void {
    const live = new Set<PlayerId>();
    for (const player of [snapshot.self, ...snapshot.visiblePlayers]) {
      const rendered = renderedPlayers.get(player.id) ?? { position: player.position, aim: player.aim };
      live.add(player.id);
      const key = player.team === "blue" ? imageAssets.playerBlue.key : imageAssets.playerOrange.key;
      const image = upsertImage(this.scene, this.players, player.id, key, 42);
      image.setPosition(rendered.position.x, rendered.position.y);
      image.setRotation(rendered.aim);
      image.setAlpha(player.id === snapshot.playerId ? 1 : 0.86);
      setMaxWorldSize(image, PLAYER_SPRITE_WORLD_SIZE);
      this.renderWeapon(player.id, player.weaponId, rendered, player.id === snapshot.playerId);
    }
    pruneMissing(this.players, live);
    pruneMissing(this.weapons, live);
  }

  private renderWeapon(playerId: PlayerId, weaponId: keyof typeof weaponSpriteAssets, rendered: RenderedPlayer, isSelf: boolean): void {
    const config = weaponSpriteAssets[weaponId] ?? weaponSpriteAssets.assault;
    const image = upsertImage(this.scene, this.weapons, playerId, config.asset.key, 43);
    const x = rendered.position.x + Math.cos(rendered.aim) * config.offsetX;
    const y = rendered.position.y + Math.sin(rendered.aim) * config.offsetX;
    image.setPosition(x, y);
    image.setRotation(rendered.aim);
    image.setAlpha(isSelf ? 1 : 0.88);
    setWorldWidth(image, config.worldLength);
  }

  private renderGadgets(snapshot: ServerSnapshot): void {
    const live = new Set<string>();
    for (const camera of snapshot.gadgets.cameras) this.renderCamera(camera, snapshot.playerId, live);
    for (const sensor of snapshot.gadgets.soundSensors) this.renderSoundSensor(sensor, snapshot.tick, live);
    for (const zone of snapshot.gadgets.molotovs) this.renderZone(zone, imageAssets.molotov.key, live, 0.9);
    for (const zone of snapshot.gadgets.smokes) this.renderZone(zone, imageAssets.smoke.key, live, 0.72);
    for (const wall of snapshot.map.walls) this.renderDeployableWall(wall, live);
    pruneMissing(this.gadgets, live);
  }

  private renderCamera(camera: DeployedCamera, playerId: PlayerId, live: Set<string>): void {
    const id = `camera:${camera.id}`;
    live.add(id);
    const image = upsertImage(this.scene, this.gadgets, id, imageAssets.camera.key, 41);
    image.setPosition(camera.position.x, camera.position.y);
    image.setRotation(0);
    image.setScale(0.5);
    image.setAlpha(camera.destroyed ? 0.35 : camera.owner === playerId ? 1 : 0.68);
  }

  private renderSoundSensor(sensor: SoundSensorZone, tick: number, live: Set<string>): void {
    const id = `sound:${sensor.id}`;
    live.add(id);
    const triggered = (sensor.triggeredUntilTick ?? 0) >= tick;
    const image = upsertImage(this.scene, this.gadgets, id, imageAssets.soundSensor.key, 41);
    image.setPosition(sensor.position.x, sensor.position.y);
    image.setRotation(0);
    image.setScale(triggered ? 0.52 : 0.48);
    image.setAlpha(triggered ? 0.9 : 0.75);
  }

  private renderZone(zone: MolotovZone | SmokeZone, key: string, live: Set<string>, alpha: number): void {
    const id = `${key}:${zone.id}`;
    live.add(id);
    const image = upsertImage(this.scene, this.gadgets, id, key, 39);
    image.setPosition(zone.position.x, zone.position.y);
    image.setRotation(0);
    image.setScale(Math.max(0.6, zone.radius / 32));
    image.setAlpha(alpha);
  }

  private renderDeployableWall(wall: Wall, live: Set<string>): void {
    if (segmentPreset(wall) !== "deployable-wall" || wall.destroyed) return;
    const id = `wall:${wall.id}`;
    live.add(id);
    const image = upsertImage(this.scene, this.gadgets, id, imageAssets.deployableWall.key, 40);
    const angle = Math.atan2(wall.b.y - wall.a.y, wall.b.x - wall.a.x);
    image.setPosition((wall.a.x + wall.b.x) / 2, (wall.a.y + wall.b.y) / 2);
    image.setRotation(angle);
    image.setScale(Math.max(0.5, Phaser.Math.Distance.Between(wall.a.x, wall.a.y, wall.b.x, wall.b.y) / 64), Math.max(0.5, wall.thickness / 10));
    image.setAlpha(0.92);
  }
}

export function playImpactSprite(scene: Phaser.Scene, position: Vec2): void {
  const image = scene.add.image(position.x, position.y, imageAssets.bulletImpact.key).setDepth(61).setScale(0.45).setAlpha(0.9);
  scene.tweens.add({ targets: image, alpha: 0, scale: 0.8, duration: 140, onComplete: () => image.destroy() });
}

export function playMuzzleFlashSprite(scene: Phaser.Scene, origin: Vec2, aim: number): void {
  const image = scene.add.image(origin.x + Math.cos(aim) * 18, origin.y + Math.sin(aim) * 18, imageAssets.muzzleFlash.key).setDepth(60).setRotation(aim).setScale(0.42).setAlpha(0.9);
  scene.tweens.add({ targets: image, alpha: 0, scale: 0.72, duration: 90, onComplete: () => image.destroy() });
}

function upsertImage<T extends string>(scene: Phaser.Scene, map: Map<T, Phaser.GameObjects.Image>, id: T, key: string, depth: number): Phaser.GameObjects.Image {
  const existing = map.get(id);
  if (existing && existing.texture.key === key) return existing;
  existing?.destroy();
  const image = scene.add.image(0, 0, key).setDepth(depth).setOrigin(0.5, 0.5);
  map.set(id, image);
  return image;
}

function pruneMissing<T extends string>(map: Map<T, Phaser.GameObjects.Image>, live: Set<T>): void {
  for (const [id, image] of map) {
    if (live.has(id)) continue;
    image.destroy();
    map.delete(id);
  }
}

function clearImageMap<T extends string>(map: Map<T, Phaser.GameObjects.Image>): void {
  for (const image of map.values()) image.destroy();
  map.clear();
}

function setMaxWorldSize(image: Phaser.GameObjects.Image, size: number): void {
  const sourceMax = Math.max(image.width, image.height, 1);
  image.setScale(size / sourceMax);
}

function setWorldWidth(image: Phaser.GameObjects.Image, width: number): void {
  image.setScale(width / Math.max(image.width, 1));
}
