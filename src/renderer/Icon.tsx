import React from "react";
const paths = {
  plus: "M12 5v14M5 12h14",
  expand: "M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5",
  play: "m9 5 11 7-11 7Z",
  pause: "M8 5v14M16 5v14",
  folder: "M3 7V5h6l2 2h10v13H3Z",
  save: "M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8",
  undo: "M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12",
  redo: "m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12",
  export: "M12 15V3m-5 5 5-5 5 5M4 14v7h16v-7",
  video: "M3 5h13v14H3Zm13 5 5-3v10l-5-3",
  search: "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  close: "m6 6 12 12M6 18 18 6",
  left: "m14 6-6 6 6 6",
  right: "m10 6 6 6-6 6",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  list: "M8 5h13M8 12h13M8 19h13M3 5h.1M3 12h.1M3 19h.1",
  check: "m4 12 5 5L20 6",
  scissors:
    "m9 9 11 11M9 15 20 4M9 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm0 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  help: "M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 3m0 4h.1M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  grip: "M8 5h.1M8 12h.1M8 19h.1M15 5h.1M15 12h.1M15 19h.1",
  audio: "M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4",
};
export function Icon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
