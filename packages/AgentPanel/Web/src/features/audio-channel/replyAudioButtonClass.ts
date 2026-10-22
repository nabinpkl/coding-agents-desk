/** The look of the two buttons that end a reply (`ReplyAudioButtons`): ink while one is playing. */
export function replyAudioButtonClass(active: boolean): string {
  return (
    "inline-flex size-[1.9em] items-center justify-center rounded-sm outline-none transition-colors " +
    "hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary " +
    "active:bg-foreground/10 " +
    (active ? "text-primary" : "session-muted-ink")
  );
}
