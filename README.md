# Tactical 1v1 Information Warfare Shooter

Competitive 2D tactical shooter prototype focused on temporary information control, repositioning, deception, and environmental adaptation.

## Local Development

```sh
nix develop
npm install
npm run dev
```

Open two browser tabs at the Vite URL, join the same local room, and play the Prototype 1 slice.

## Commands

- `npm run dev` - run the authoritative server and Phaser client.
- `npm run dev:server` - run only the Node WebSocket server.
- `npm run dev:client` - run only the Vite/Phaser client.
- `npm run typecheck` - typecheck every workspace.
- `npm test` - run unit and integration tests.
- `npm run build` - build all workspaces.

## Prototype 1

- Server-authoritative 1v1 local rooms.
- Fixed 20 Hz simulation.
- Current LOS plus explored fog.
- Filtered snapshots so hidden enemy state is not sent.
- Camera and motion sensor detection.
- Destructible wall route creation.
- Tactical holo-style Phaser renderer.
- Built-in editor and visibility debugger foundations.
