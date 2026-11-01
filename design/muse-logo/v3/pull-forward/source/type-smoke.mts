import Model from '../motion/pull-forward.mjs';
import Controller from '../motion/controller.mjs';
const svg: string = Model.svg({ theme: 'dark', focusIndex: 1 });
const pose = Model.pose({ motion: true, time: 1 });
const controller = new Controller(document.createElement('span'), { onStateChange: state => { const active: number = state.focusIndex; void active; } });
const accepted: boolean = controller.advance();
controller.destroy();
void svg;void pose;void accepted;
