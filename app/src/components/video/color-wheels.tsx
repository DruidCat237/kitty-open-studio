"use client";

type RGB = { r: number; g: number; b: number };

function WheelSliders({
  label,
  value,
  onChange,
}: {
  label: string;
  value: RGB;
  onChange: (v: RGB) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold text-muted-foreground">{label}</span>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-red-400 w-3">R</span>
          <input
            type="range"
            className="flex-1 h-1 accent-red-500 cursor-pointer"
            min={-100}
            max={100}
            step={1}
            value={Math.round(value.r * 100)}
            onChange={(e) => onChange({ ...value, r: Number(e.target.value) / 100 })}
          />
          <span className="text-[9px] text-muted-foreground w-7 text-right tabular-nums">
            {Math.round(value.r * 100)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-green-400 w-3">G</span>
          <input
            type="range"
            className="flex-1 h-1 accent-green-500 cursor-pointer"
            min={-100}
            max={100}
            step={1}
            value={Math.round(value.g * 100)}
            onChange={(e) => onChange({ ...value, g: Number(e.target.value) / 100 })}
          />
          <span className="text-[9px] text-muted-foreground w-7 text-right tabular-nums">
            {Math.round(value.g * 100)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[9px] text-blue-400 w-3">B</span>
          <input
            type="range"
            className="flex-1 h-1 accent-blue-500 cursor-pointer"
            min={-100}
            max={100}
            step={1}
            value={Math.round(value.b * 100)}
            onChange={(e) => onChange({ ...value, b: Number(e.target.value) / 100 })}
          />
          <span className="text-[9px] text-muted-foreground w-7 text-right tabular-nums">
            {Math.round(value.b * 100)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ColorWheels({
  lift,
  gamma,
  gain,
  onLiftChange,
  onGammaChange,
  onGainChange,
  onResetAll,
}: {
  lift: RGB;
  gamma: RGB;
  gain: RGB;
  onLiftChange: (v: RGB) => void;
  onGammaChange: (v: RGB) => void;
  onGainChange: (v: RGB) => void;
  onResetAll?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <WheelSliders label="Shadows (Lift)" value={lift} onChange={onLiftChange} />
      <WheelSliders label="Midtones (Gamma)" value={gamma} onChange={onGammaChange} />
      <WheelSliders label="Highlights (Gain)" value={gain} onChange={onGainChange} />
      {onResetAll && (
        <div className="flex justify-end">
          <button
            type="button"
            className="text-[9px] text-muted-foreground hover:text-white"
            onClick={onResetAll}
          >
            Reset All
          </button>
        </div>
      )}
    </div>
  );
}
