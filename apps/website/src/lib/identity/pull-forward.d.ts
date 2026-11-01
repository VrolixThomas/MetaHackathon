export as namespace PullForward;
export = PullForward;
declare namespace PullForward {
  type Theme = 'dark' | 'light';
  interface Options {
    size?: number; tile?: boolean; theme?: Theme; mono?: boolean; crisp?: boolean;
    idPrefix?: string; focusIndex?: number; transition?: number; time?: number;
    motion?: boolean; auto?: boolean; background?: boolean;
  }
  interface Part {
    id: string; item: number; slot: number; target: number; depth: number; emphasis: number;
    d: string; edge: string; color: string; x: number; y: number; cx: number; cy: number;
    r: number; primaryPeak: number; secondaryPeak: number; edgeOpacity: number;
    vertices: number[][]; transform: string;
  }
  interface Pose {
    kind: 'pull'; palette: 'blue'; focusIndex: number; nextIndex: number;
    shownIndex: number; transition: number; parts: Part[];
  }
  const PALETTE: Readonly<{ name: string; far: string; near: string; active: string; light: string; ice: string; ambient: string; bg: string }>;
  const STEP: number;
  const HOLD: number;
  const SWAP: number;
  const TOUR: number;
  function svg(options?: Options): string;
  function micro(options?: Pick<Options, 'size' | 'theme' | 'mono'>): string;
  function pose(options?: Options): Pose;
  function tour(time: number): { focusIndex: number; transition: number };
  function ease(progress: number): number;
}
