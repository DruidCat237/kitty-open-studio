import { cn } from "@/lib/utils";
import { LoaderCircleIcon } from "lucide-react";

type LoadingIconProps = Parameters<typeof LoaderCircleIcon>[0];

export function LoadingIcon({ className, ...props }: LoadingIconProps) {
  return (
    <LoaderCircleIcon
      className={cn("opacity-50 animate-spin", className)}
      {...props}
    />
  );
}
