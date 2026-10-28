// AspectRatioSelector.tsx
import { cn } from "@/lib/utils";
import type { MouseEventHandler } from "react";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const aspectRatioOptions = {
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "9:16": 9 / 16,
} as const;

export type AspectRatioOption = keyof typeof aspectRatioOptions;

interface AspectRatioSelectorProps {
  className?: string;
  onValueChange?: (ratio: AspectRatioOption | null) => void;
  value: AspectRatioOption | null;
}

export function AspectRatioSelector({
  className,
  onValueChange,
  value,
}: AspectRatioSelectorProps) {
  const handleOnClick = (ratio: AspectRatioOption) => {
    return ((e) => {
      e.preventDefault();
      if (value === ratio) {
        onValueChange?.(null);
        return;
      }
      onValueChange?.(ratio);
    }) as MouseEventHandler<HTMLButtonElement>;
  };
  const ratioValue = value ? aspectRatioOptions[value] : 0;

  return (
    <div
      className={cn(
        "mx-auto w-full flex-col items-center justify-center gap-4",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <ToggleGroup type="single" size="xs" value={value ?? ""}>
          {Object.keys(aspectRatioOptions).map((option) => (
            <ToggleGroupItem
              key={option}
              className="tabular-nums"
              onClick={handleOnClick(option as AspectRatioOption)}
              value={option}
            >
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="flex aspect-square w-full items-center justify-center">
        <div className="relative flex aspect-square h-full w-full items-center justify-center">
          <div className="text-sm tabular-nums">{value ?? "default"}</div>
          {!!value && (
            <div
              className={cn(
                "absolute border border-primary",
                "z-40 transition-all",
                {
                  "w-2/5": ratioValue <= 1,
                  "h-2/5": ratioValue > 1,
                },
              )}
              style={{
                aspectRatio: value.replace(":", "/"),
              }}
            />
          )}
          {Object.entries(aspectRatioOptions).map(([option, ratio]) => (
            <div
              key={option}
              className={cn(
                "absolute border border-dashed border-muted-foreground/70 transition-colors",
                {
                  "w-2/5": ratio <= 1,
                  "h-2/5": ratio > 1,
                },
              )}
              style={{
                aspectRatio: option.replace(":", "/"),
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
