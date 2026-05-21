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
        <p class="menu-copy">Build readable maps, tag tactical surfaces, and test vision/sound information before live combat returns.</p>
        <div class="menu-actions">
          <a class="primary-action" href="/play">Play</a>
          <a class="secondary-action" href="/editor">Map Editor</a>
        </div>
        <dl class="menu-status">
          <div><dt>Play</dt><dd>Dummy placeholder</dd></div>
          <div><dt>Editor</dt><dd>Disk-backed JSON maps</dd></div>
          <div><dt>Graphics</dt><dd>Demo tactical shapes</dd></div>
        </dl>
      </section>
    `;
    document.body.appendChild(shell);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => shell.remove());
  }
}
