// ApplyPilot logo — a low-poly faceted paper plane. Three folds of one coral hue (light/mid/deep)
// read as folded paper in 3D without any gradient. Square viewBox so it works as a rail mark and as
// an app-icon source. Pass `tile` to render the rounded-square backdrop (icon form).
export function Logo({ size = 32, tile = false }: { size?: number; tile?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="ApplyPilot" fill="none" xmlns="http://www.w3.org/2000/svg">
      {tile && <rect x="2" y="2" width="96" height="96" rx="22" fill="#e8734a" />}
      <polygon points="86,42 16,24 55,47" fill={tile ? "#fbe9d2" : "#f6c98a"} />
      <polygon points="86,42 55,47 34,76" fill={tile ? "#f4a06f" : "#ef8a5f"} />
      <polygon points="16,24 55,47 34,76" fill={tile ? "#b9442a" : "#cf4f30"} />
      <line x1="55" y1="47" x2="86" y2="42" stroke={tile ? "#a23a22" : "#b03f25"} strokeWidth="1.4" strokeLinecap="round" />
      <line x1="55" y1="47" x2="16" y2="24" stroke="#fff3e0" strokeWidth="1.2" strokeLinecap="round" opacity="0.7" />
      <line x1="55" y1="47" x2="34" y2="76" stroke={tile ? "#a23a22" : "#b03f25"} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
