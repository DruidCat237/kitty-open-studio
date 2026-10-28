import { StudioHome } from "@/components/studio/studio-home";
import { Suspense } from "react";

export default function StudioPage() {
  return (
    <Suspense>
      <StudioHome />
    </Suspense>
  );
}
