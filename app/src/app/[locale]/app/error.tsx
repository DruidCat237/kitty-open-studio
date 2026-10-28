"use client";

import { useEffect } from "react";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[AppError]", error);
  }, [error]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
      <div className="text-center max-w-md px-6">
        <div className="text-4xl mb-4">:(</div>
        <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {error.message || "An unexpected error occurred in the app."}
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={reset}
            className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-md transition-colors"
          >
            Try Again
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 text-sm bg-zinc-700 hover:bg-zinc-600 text-white rounded-md transition-colors"
          >
            Reload Page
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-6">
          If this keeps happening, try restarting the app.
        </p>
      </div>
    </div>
  );
}
