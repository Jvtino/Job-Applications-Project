// Thin wrapper over the Sunrise icon sprite (injected in index.html).
export type IconName =
  | "arrow-left"
  | "arrow-right"
  | "bell"
  | "board"
  | "check"
  | "clock"
  | "file"
  | "filter"
  | "pause"
  | "play"
  | "search"
  | "send"
  | "settings"
  | "shield"
  | "spark"
  | "star"
  | "stop"
  | "upload";

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon">
      <use href={`#i-${name}`} />
    </svg>
  );
}
