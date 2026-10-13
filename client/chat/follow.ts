/**
 * Whether the chat keeps scrolling to new messages. Following used to be decided by how far the
 * view was from the bottom at every scroll event; when a turn added more than that margin in one go
 * (a long reply, the footer after it, rows measured late in a windowed list) the view was suddenly
 * "away from the bottom", following stopped for good and the reader had to scroll down by hand.
 * Now following only stops when the reader scrolls up, and starts again when they get back to the bottom.
 */
export function nextFollow(input: {
  follow: boolean;
  /** Distance of the view from the bottom of the content, now. */
  distance: number;
  offset: number;
  previousOffset: number;
  content: number;
  previousContent: number;
  /** The app scrolled the list itself a moment ago. */
  programmatic: boolean;
  threshold: number;
}): boolean {
  if (input.distance <= input.threshold) return true;
  if (input.programmatic) return input.follow;
  // A list that got shorter moves the view up without the reader doing anything.
  if (input.content < input.previousContent) return input.follow;
  if (input.offset < input.previousOffset - 2) return false;
  return input.follow;
}
