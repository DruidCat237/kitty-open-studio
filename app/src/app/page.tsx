"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RootPage() {
  const router = useRouter();

  useEffect(() => {
    const saved = localStorage.getItem("preferred-locale");
    router.replace(`/${saved || "en"}`);
  }, [router]);

  // The root layout renders no <html>/<body> (the [locale] layout does), so this redirect page brings its own.
  return (
    <html lang="en">
      <body className="antialiased dark" />
    </html>
  );
}
