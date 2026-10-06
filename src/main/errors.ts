/** Native diagnostics stay in main; callers receive a path-free message. */
export function publicErrorMessage(error: unknown): string {
  if (
    typeof (error as NodeJS.ErrnoException)?.code === "string" &&
    /^E[A-Z]+$/.test((error as NodeJS.ErrnoException).code!)
  )
    return "Local file or runtime is unavailable; check the selected resource";
  const message = error instanceof Error ? error.message : "Operation failed";
  return message.replace(/(?:\/[^\s\"\'<>]+)+/g, "[local resource]");
}
