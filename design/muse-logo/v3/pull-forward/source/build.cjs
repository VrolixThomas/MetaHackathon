/* Build the final selected mark only. Writes stay within this asset-kit folder. */
const fs=require('node:fs'),path=require('node:path'),M=require('../motion/pull-forward.js');
const root=path.resolve(__dirname,'..');
function write(p,s){p=path.join(root,p);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s.trimEnd()+'\n');}
function ink(svg,from,to){return svg.split(from).join(to);}
write('svg/pull-forward.svg',M.svg());
write('svg/pull-forward-light.svg',M.svg({theme:'light'}));
write('svg/pull-forward-white.svg',ink(M.svg({mono:true}),'#EDF7FF','#FFFFFF'));
write('svg/pull-forward-black.svg',ink(M.svg({mono:true,theme:'light'}),'#172B3C','#000000'));
write('svg/pull-forward-ink.svg',M.svg({mono:true,theme:'light'}));
write('svg/pull-forward-current-color.svg',ink(M.svg({mono:true}),'#EDF7FF','currentColor'));
function flat(theme){const pal=M.PALETTE;let body='';for(const q of M.pose().parts)body+=`<path d="${q.d}" fill="${q.emphasis>.5?(theme==='dark'?pal.light:pal.active):(q.slot===1?pal.near:pal.far)}"/>`;return `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256" role="img" aria-label="Pull forward flat mark">${body}</svg>`;}
write('svg/pull-forward-flat-dark.svg',flat('dark'));
write('svg/pull-forward-flat-light.svg',flat('light'));
for(const theme of ['dark','light'])write(`icons/svg/app-icon-${theme}.svg`,M.svg({theme,tile:true,size:1024}));
function fullBleed(theme){const bg=theme==='dark'?M.PALETTE.bg:'#EDF3F7';return M.svg({theme}).replace(/(<svg[^>]*>)/,`$1<rect width="256" height="256" fill="${bg}"/>`);}
write('icons/svg/app-icon-square-dark.svg',fullBleed('dark'));
write('icons/svg/app-icon-square-light.svg',fullBleed('light'));
for(const size of [16,20,24,32,48,64])for(const theme of ['dark','light'])write(`svg/ui/pull-forward-${size}-${theme}.svg`,M.micro({size,theme}));
write('svg/ui/pull-forward-template.svg',ink(M.micro({mono:true,theme:'light'}),'#172B3C','#000000'));
write('web/favicon.svg',M.svg({tile:true}));
write('web/pinned-tab.svg',ink(M.micro({mono:true,theme:'light'}),'#172B3C','#000000'));
for(const [name,progress] of [['held',0],['handoff-out',.25],['handoff-middle',.5],['handoff-in',.75],['next-held',1]]){
  write(`motion/keyframes/${name}.svg`,M.svg({transition:progress}));
  write(`motion/keyframes/${name}-on-dark.svg`,M.svg({transition:progress,tile:true}));
}
write('motion/reduced-motion.svg',M.svg());
const tokens={identity:'Pull forward',designTheme:'Focus',primaryPalette:'Blue / Ice',viewBox:[0,0,256,256],colors:M.PALETTE,spacing:{minimumOutsideClearSpaceRatio:.125,minimumMicroOutsidePixels:2},usage:{microSizes:[16,20,24,32],richRecommendedMinimumPixels:48},motion:{handoffMilliseconds:800,backgroundCycleMilliseconds:3200,illustrativeHoldMilliseconds:2400,illustrativeTourMilliseconds:9600,automaticFocusAdvance:false}};
write('brand-tokens.json',JSON.stringify(tokens,null,2));
// Generate native ESM from the same selected source, so there is no divergent model.
const coreSource=fs.readFileSync(path.join(root,'motion/pull-forward.js'),'utf8');
const coreStart=coreSource.indexOf("  'use strict';"),coreEnd=coreSource.indexOf("if(typeof module!=='undefined'&&module.exports)module.exports=api;");
if(coreStart<0||coreEnd<0)throw new Error('Cannot locate selected model for ESM export');
let coreESM=coreSource.slice(coreStart,coreEnd).replace("svg:(options={})=>svg('pull',{...options,palette:'blue'})", "svg:(options={})=>svg('pull',{...options,idPrefix:(options.idPrefix||'art')+'-esm',palette:'blue'})");
write('motion/pull-forward.mjs','/* Generated from pull-forward.js by source/build.cjs. */\n'+coreESM+'\nexport {api as PullForward};\nexport default api;');
const controllerSource=fs.readFileSync(path.join(root,'motion/controller.js'),'utf8');
const controllerStart=controllerSource.indexOf("  'use strict';"),controllerEnd=controllerSource.lastIndexOf('  return Controller;');
if(controllerStart<0||controllerEnd<0)throw new Error('Cannot locate controller for ESM export');
write('motion/controller.mjs',"/* Generated from controller.js by source/build.cjs. */\nimport Model from './pull-forward.mjs';\n"+controllerSource.slice(controllerStart,controllerEnd)+'\nexport {Controller};\nexport default Controller;');
let html=fs.readFileSync(path.join(root,'source/preview.template.html'),'utf8');
html=html.replace('/*CSS*/',fs.readFileSync(path.join(root,'motion/pull-forward.css'),'utf8'))
  .replace('/*MODEL*/',fs.readFileSync(path.join(root,'motion/pull-forward.js'),'utf8'))
  .replace('/*CONTROLLER*/',fs.readFileSync(path.join(root,'motion/controller.js'),'utf8'))
  .replace('/*DEMO*/',fs.readFileSync(path.join(root,'source/demo.js'),'utf8'))
  .replace('<!--SMALL-->',[16,20,24,32].map(size=>`<div>${M.micro({size})}<span>${size}px</span></div>`).join(''))
  .replace('<!--MONO-->',ink(M.svg({mono:true,size:100}),'#EDF7FF','#FFFFFF'));
write('index.html',html);console.log('Built final SVG masters, UI art, keyframes, tokens and self-contained demo.');
