import Phaser from "phaser";
import { colors } from "../render";

export class MenuScene extends Phaser.Scene {
  constructor() {
    super("menu");
  }

  create(): void {
    this.cameras.main.setBackgroundColor(colors.bg);
    const shell = document.createElement("main");
    shell.className = "menu-shell";
    shell.innerHTML = `
      <section class="menu-panel">
        <p class="eyebrow">Tactical Signal Prototype</p>
        <h1>Information Warfare Shooter</h1>
        <p class="menu-copy">Create a local match on a saved tactical map, or open the editor to build geometry, doors, spawns, and destructible surfaces.</p>
        <div class="menu-actions">
          <a class="primary-action" href="/play">Play</a>
          <a class="secondary-action" href="/editor">Map Editor</a>
        </div>
      </section>
    `;
    document.body.appendChild(shell);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => shell.remove());
  }
}
