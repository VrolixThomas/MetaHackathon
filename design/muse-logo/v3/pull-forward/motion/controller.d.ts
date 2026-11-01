export as namespace PullForwardController;
export = PullForwardController;
declare class PullForwardController {
  constructor(host: HTMLElement, options?: PullForwardController.Options);
  readonly host: HTMLElement;
  advance(): boolean;
  reset(): void;
  pause(): void;
  resume(): void;
  setBackgroundMotion(enabled: boolean): void;
  setTheme(theme: 'dark' | 'light'): void;
  setReducedMotion(enabled: boolean): void;
  getState(): PullForwardController.State;
  destroy(): void;
}
declare namespace PullForwardController {
  interface State {
    focusIndex: number; nextIndex: number; transitioning: boolean; progress: number;
    paused: boolean; reducedMotion: boolean; backgroundMotion: boolean;
    theme: 'dark' | 'light'; destroyed: boolean;
  }
  interface Options {
    size?: number; theme?: 'dark' | 'light'; backgroundMotion?: boolean;
    reducedMotion?: boolean; decorative?: boolean; label?: string;
    onStateChange?: (state: State) => void;
  }
}
