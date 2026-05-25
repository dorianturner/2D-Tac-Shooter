import type { AudibleEvent, PlayerId, Vec2 } from "@tac/shared";

type BrowserAudioContext = AudioContext & { createStereoPanner?: () => StereoPannerNode };
type AudioContextConstructor = new () => BrowserAudioContext;

const maxSeenEvents = 700;

export class AudioDirector {
  private context: BrowserAudioContext | undefined = undefined;
  private seen = new Set<string>();
  private seenOrder: string[] = [];

  async unlock(): Promise<void> {
    const Ctor = audioContextConstructor();
    if (!Ctor) return;
    this.context ??= new Ctor();
    if (this.context.state === "suspended") await this.context.resume();
  }

  playEvents(events: AudibleEvent[], listener: Vec2, localPlayerId: PlayerId): void {
    if (!this.context || this.context.state !== "running") return;
    for (const event of events) {
      if (this.seen.has(event.id)) continue;
      this.markSeen(event.id);
      this.playEvent(event, listener, event.sourceId === localPlayerId);
    }
  }

  dispose(): void {
    void this.context?.close();
    this.context = undefined;
    this.seen.clear();
    this.seenOrder = [];
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    this.seenOrder.push(id);
    while (this.seenOrder.length > maxSeenEvents) {
      const old = this.seenOrder.shift();
      if (old) this.seen.delete(old);
    }
  }

  private playEvent(event: AudibleEvent, listener: Vec2, local: boolean): void {
    const gain = eventGain(event, listener, local);
    const pan = local ? 0 : Math.max(-1, Math.min(1, (event.position.x - listener.x) / Math.max(1, event.radius)));
    if (event.kind === "gunshot") this.gunshot(event, gain, pan);
    else if (event.kind === "reload") this.reload(event, gain, pan);
    else if (event.kind === "footstep") this.footstep(event, gain, pan);
    else if (event.kind === "gadget") this.gadget(event, gain, pan);
    else if (event.kind === "ability") this.ability(event, gain, pan);
    else if (event.kind === "impact") this.impact(event, gain, pan);
    else if (event.kind === "door") this.door(event, gain, pan);
    else if (event.kind === "round") this.round(event, gain);
    else if (event.kind === "damage") this.damage(event, gain, pan);
  }

  private gunshot(event: AudibleEvent, gain: number, pan: number): void {
    const subtype = event.weaponId ?? event.subtype;
    if (subtype === "sniper") {
      this.noise(0.11, gain * 1.1, pan, "highpass", 900);
      this.tone(72, 0.14, gain * 0.85, pan, "sawtooth");
      return;
    }
    if (subtype === "shotgun") {
      this.noise(0.12, gain, pan, "bandpass", 620);
      this.tone(96, 0.08, gain * 0.55, pan, "square");
      return;
    }
    this.noise(0.055, gain * 0.72, pan, "highpass", 1200);
    this.tone(150, 0.045, gain * 0.36, pan, "square");
  }

  private reload(event: AudibleEvent, gain: number, pan: number): void {
    const start = this.context!.currentTime;
    const base = event.subtype === "complete" ? 420 : 260;
    this.tone(base, 0.035, gain * 0.38, pan, "triangle", start);
    this.tone(base * 1.5, 0.04, gain * 0.3, pan, "triangle", start + 0.08);
  }

  private footstep(event: AudibleEvent, gain: number, pan: number): void {
    const walking = event.subtype === "walk";
    this.noise(walking ? 0.035 : 0.055, gain * (walking ? 0.22 : 0.48), pan, "lowpass", walking ? 240 : 360);
    this.tone(walking ? 95 : 118, walking ? 0.035 : 0.045, gain * 0.18, pan, "sine");
  }

  private gadget(event: AudibleEvent, gain: number, pan: number): void {
    if (event.gadget === "molotov") {
      this.noise(0.16, gain * 0.42, pan, "bandpass", 520);
      this.tone(190, 0.11, gain * 0.34, pan, "sawtooth");
      return;
    }
    if (event.gadget === "smoke") {
      this.noise(0.22, gain * 0.38, pan, "lowpass", 420);
      return;
    }
    if (event.gadget === "wall") {
      this.tone(130, 0.08, gain * 0.44, pan, "square");
      this.noise(0.09, gain * 0.32, pan, "lowpass", 300);
      return;
    }
    this.tone(event.gadget === "sound" ? 610 : 480, 0.09, gain * 0.35, pan, "triangle");
  }

  private ability(event: AudibleEvent, gain: number, pan: number): void {
    const start = this.context!.currentTime;
    if (event.abilityId === "dash") {
      this.noise(0.13, gain * 0.45, pan, "highpass", 700);
      this.tone(220, 0.08, gain * 0.28, pan, "sawtooth");
      return;
    }
    if (event.abilityId === "breach-any") {
      this.noise(0.18, gain * 0.58, pan, "lowpass", 460);
      this.tone(85, 0.16, gain * 0.48, pan, "square");
      return;
    }
    this.tone(520, 0.06, gain * 0.36, pan, "triangle", start);
    this.tone(780, 0.07, gain * 0.28, pan, "triangle", start + 0.07);
  }

  private impact(event: AudibleEvent, gain: number, pan: number): void {
    const heavy = event.subtype?.includes("destroy") || event.subtype?.includes("break");
    this.noise(heavy ? 0.15 : 0.055, gain * (heavy ? 0.55 : 0.32), pan, "bandpass", heavy ? 340 : 1100);
    if (heavy) this.tone(92, 0.13, gain * 0.32, pan, "sawtooth");
  }

  private door(event: AudibleEvent, gain: number, pan: number): void {
    const shot = event.subtype?.includes("shot");
    this.tone(shot ? 115 : 180, shot ? 0.11 : 0.18, gain * (shot ? 0.44 : 0.28), pan, "sawtooth");
    this.noise(shot ? 0.08 : 0.11, gain * 0.22, pan, "bandpass", shot ? 520 : 280);
  }

  private round(event: AudibleEvent, gain: number): void {
    const start = this.context!.currentTime;
    const base = event.subtype === "start" ? 330 : event.subtype === "overtime" ? 240 : 180;
    this.tone(base, 0.11, gain * 0.38, 0, "triangle", start);
    this.tone(base * 1.5, 0.14, gain * 0.34, 0, "triangle", start + 0.12);
  }

  private damage(event: AudibleEvent, gain: number, pan: number): void {
    this.tone(event.subtype === "kill" ? 90 : 140, 0.09, gain * 0.38, pan, "sawtooth");
    this.noise(0.05, gain * 0.25, pan, "lowpass", 460);
  }

  private tone(frequency: number, duration: number, gain: number, pan: number, type: OscillatorType, startAt = this.context!.currentTime): void {
    const context = this.context!;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    envelope.gain.setValueAtTime(0.0001, startAt);
    envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), startAt + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(envelope);
    connectOutput(context, envelope, pan);
    oscillator.start(startAt);
    oscillator.stop(startAt + duration + 0.02);
  }

  private noise(duration: number, gain: number, pan: number, filterType: BiquadFilterType, frequency: number): void {
    const context = this.context!;
    const sampleCount = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < sampleCount; index += 1) data[index] = Math.random() * 2 - 1;
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const envelope = context.createGain();
    const now = context.currentTime;
    filter.type = filterType;
    filter.frequency.setValueAtTime(frequency, now);
    envelope.gain.setValueAtTime(Math.max(0.0001, gain), now);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.buffer = buffer;
    source.connect(filter);
    filter.connect(envelope);
    connectOutput(context, envelope, pan);
    source.start(now);
    source.stop(now + duration + 0.02);
  }
}

function eventGain(event: AudibleEvent, listener: Vec2, local: boolean): number {
  if (local) return Math.min(1, event.volume);
  const dist = Math.hypot(event.position.x - listener.x, event.position.y - listener.y);
  const falloff = Math.max(0, 1 - dist / Math.max(1, event.radius));
  return Math.min(1, event.volume * (0.18 + falloff * 0.82));
}

function connectOutput(context: BrowserAudioContext, input: AudioNode, pan: number): void {
  if (context.createStereoPanner) {
    const panner = context.createStereoPanner();
    panner.pan.value = pan;
    input.connect(panner);
    panner.connect(context.destination);
    return;
  }
  input.connect(context.destination);
}

function audioContextConstructor(): AudioContextConstructor | undefined {
  const win = window as unknown as { AudioContext?: AudioContextConstructor; webkitAudioContext?: AudioContextConstructor };
  return win.AudioContext ?? win.webkitAudioContext;
}
