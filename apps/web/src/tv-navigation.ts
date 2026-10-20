// Remote-first focus movement for the Fire TV WebView. Browsers map D-pad arrows to
// scrolling, not focus, so TV mode moves focus geometrically instead.
export type Box = {left: number; top: number; right: number; bottom: number};
export type Direction = 'up' | 'down' | 'left' | 'right';
const center = (box: Box) => ({x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2});

// Nearest visible box in the pressed direction; alignment matters more than raw distance.
export function spatialNext(boxes: Box[], current: number, direction: Direction): number | undefined {
  const from = boxes[current];
  if (!from) return undefined;
  const origin = center(from);
  let best: number | undefined, bestCost = Infinity;
  boxes.forEach((box, index) => {
    if (index === current || box.right - box.left <= 0 || box.bottom - box.top <= 0) return;
    const point = center(box), dx = point.x - origin.x, dy = point.y - origin.y;
    const forward = direction === 'left' ? -dx : direction === 'right' ? dx : direction === 'up' ? -dy : dy;
    const across = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (forward <= 1) return;
    const cost = forward + across * 2;
    if (cost < bestCost) {bestCost = cost; best = index;}
  });
  return best;
}
const focusable = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const editable = (element: Element | null) => element instanceof HTMLElement && (element.matches('input:not([type=range]):not([type=checkbox]),textarea') && !element.hasAttribute('readonly'));
const choices = (element: Element | null) => element instanceof HTMLElement && element.matches('select,input[type=range]');
const visible = (element: HTMLElement) => {
  const box = element.getBoundingClientRect(), style = window.getComputedStyle(element);
  return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
};
const candidates = () => Array.from(document.querySelectorAll<HTMLElement>(focusable)).filter(element => visible(element) && !element.closest('[inert]'));
const move = (direction: Direction) => {
  const items = candidates();
  if (!items.length) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  if (current < 0) {void items[0]!.focus(); return;}
  const next = spatialNext(items.map(element => element.getBoundingClientRect()), current, direction);
  if (next === undefined) return;
  const target = items[next]!;
  target.focus({preventScroll: true});
  target.scrollIntoView({block: 'nearest', inline: 'nearest'});
};
// Back closes an open modal first; anything else belongs to the shell (web history, then exit).
export function handleTvBack(): boolean {
  const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
  if (!dialog) return false;
  dialog.dispatchEvent(new Event('cancel', {cancelable: true}));
  return true;
}
export function installTvNavigation() {
  const root = document.documentElement;
  root.classList.add('tv-mode');
  const keys: Record<string, Direction> = {ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right'};
  const onKey = (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    const direction = keys[event.key];
    if (direction) {
      if (choices(target)) return;
      if (editable(target) && direction !== 'up' && direction !== 'down') return;
      event.preventDefault();
      move(direction);
      return;
    }
    if (event.key === 'Enter' && target === document.body) {event.preventDefault(); void candidates()[0]?.focus();}
  };
  window.addEventListener('keydown', onKey);
  // The shell calls this before its own Back handling, so a modal never traps the remote.
  (window as Window & {TkBoxTv?: {handleBack: () => boolean}}).TkBoxTv = {handleBack: handleTvBack};
  // Stopping playback returns to the guide: put the remote back where the viewer left it.
  let returnFocus: HTMLElement | null = null;
  window.addEventListener('hashchange', () => {
    if (location.hash.startsWith('#watch')) returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    else if (returnFocus?.isConnected) {returnFocus.focus({preventScroll: true}); returnFocus = null;}
  });
  return () => window.removeEventListener('keydown', onKey);
}
