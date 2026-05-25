PNG graphics go here when you are ready to replace the generated tactical placeholders.

Recommended layout:

- `sprites/player-blue.png`
- `sprites/player-orange.png`
- `sprites/assault-rifle.png`
- `sprites/sniper-rifle.png`
- `sprites/shotgun.png`
- `sprites/camera.png`
- `sprites/sound-sensor.png`
- `sprites/deployable-wall.png`
- `fx/molotov.png`
- `fx/smoke.png`
- `fx/muzzle-flash.png`
- `fx/bullet-impact.png`
- `ui/` for future HUD/menu art

Use transparent-background PNGs for anything that appears on the map. Player, gun, deployable-wall, and muzzle-flash art should face right; the game rotates those textures to match aim or placement angle. Keep readable silhouettes at small sizes: players around 64x64, guns cropped tightly around the weapon, gadgets around 48x48, deployable walls around 64x24, and short-lived FX around 32-64 px.

After adding a PNG, enable it in `apps/client/src/assets.ts` by setting the matching `path`, for example:

```ts
path: "/assets/sprites/player-blue.png"
```

If a path is not set, the preload scene creates a generated fallback texture so development still runs without art files.

Weapon sprites are configured in `weaponSpriteAssets` in `apps/client/src/assets.ts`. Adjust `offsetX` to move the weapon forward/backward along the player's aim direction so the grip lines up visually with the player's hands. Adjust `worldLength` to change how large that weapon appears in world units.
