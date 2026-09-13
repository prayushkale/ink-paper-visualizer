import type { StudioView } from '../studio/studio';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** What each element is already showing, so a heartbeat cannot rewrite it. */
const showing = new WeakMap<HTMLElement, string>();

/**
 * The still the stage holds while the film is being prepared.
 *
 * The rail is not always on screen - a narrow window hides it - so the newest
 * picture the rail has is held over the stage while the film has no picture of
 * its own. That picture is always the photograph the imagining made of a blot,
 * never the ink blot itself: the ink is a reference, and it has its own card in
 * the rail and the full-screen viewer. Once the film is running the stream is
 * the picture and this element holds nothing at all.
 *
 * It is never animated.
 */
export function renderArrivalCard(root: HTMLElement, card: StudioView['card']): void {
  if (!card || card.image === '') {
    showing.delete(root);
    root.hidden = true;
    root.innerHTML = '';
    return;
  }
  const key = `${card.id}:${card.image}`;
  if (showing.get(root) === key) return;
  showing.set(root, key);
  root.hidden = false;
  root.innerHTML = `<img src="${esc(card.image)}" alt="" aria-hidden="true" />`;
}
