import type {
  FrameListener,
  LandmarkFrame,
  LandmarkRecording,
  LandmarkSource,
} from './types';

/**
 * Feeds recorded or synthetic landmark JSON into the game. Two drive modes:
 * - start(): real-time playback using requestAnimationFrame or a timer.
 * - tick(): synchronous single-frame stepping for headless tests.
 */
export class ReplaySource implements LandmarkSource {
  private listeners = new Set<FrameListener>();
  private frames: LandmarkFrame[];
  private cursor = 0;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly label: string;
  readonly fps: number;

  constructor(recording: LandmarkRecording) {
    this.frames = recording.frames;
    this.label = recording.label;
    this.fps = recording.fps;
  }

  static async load(url: string): Promise<ReplaySource> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load recording: ${url}`);
    const recording = (await res.json()) as LandmarkRecording;
    return new ReplaySource(recording);
  }

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get done(): boolean {
    return this.cursor >= this.frames.length;
  }

  get frameCount(): number {
    return this.frames.length;
  }

  /** Synchronously emit the next frame. Returns it, or null when exhausted. */
  tick(): LandmarkFrame | null {
    const frame = this.frames[this.cursor];
    if (!frame) return null;
    this.cursor++;
    for (const l of this.listeners) l(frame);
    return frame;
  }

  /** Run every remaining frame synchronously (test convenience). */
  drain(): void {
    while (this.tick() !== null) {
      // tick emits to listeners
    }
  }

  reset(): void {
    this.cursor = 0;
  }

  async start(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    const interval = 1000 / this.fps;
    const step = () => {
      if (!this.playing) return;
      if (this.tick() === null) {
        this.playing = false;
        return;
      }
      this.timer = setTimeout(step, interval);
    };
    step();
  }

  stop(): void {
    this.playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
