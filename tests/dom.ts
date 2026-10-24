// A real DOM for component tests. React components are rendered for real here, so the globals must
// exist before those modules are evaluated: import this module first in a test file.
import {JSDOM} from 'jsdom';

const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://localhost/'});
// jsdom 27 exposes the browser globals the components read (window, document, storage, events);
// declaring them is what makes the module graph behave as it does in the browser.
const globals=globalThis as unknown as Record<string,unknown>;
for(const [name,value] of Object.entries({window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,
  Node:dom.window.Node,Event:dom.window.Event,MutationObserver:dom.window.MutationObserver,
  localStorage:dom.window.localStorage,sessionStorage:dom.window.sessionStorage,IS_REACT_ACT_ENVIRONMENT:true}))
  Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
