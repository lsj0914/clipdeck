/** User sources must be single-file containers. Manifest/sequence demuxers can
 * read files outside native source authorization and evade the source hash. */
export const SOURCE_INPUT_OPTIONS = [
  "-protocol_whitelist", "file",
  "-format_whitelist", "mov,matroska,avi,mpeg,mpegts,ogg",
] as const;
