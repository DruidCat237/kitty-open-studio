import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * Save a blob to a temp file for stabilization.
 * Returns the absolute path so electronAPI.stabilizeNative can use it.
 */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const tmpDir = os.tmpdir();
    const rawExt = file.name.split(".").pop() || "mp4";
    const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "mp4";
    const tmpFile = path.join(tmpDir, `kitty_stabilize_${Date.now()}.${ext}`);
    const arrayBuf = await file.arrayBuffer();
    fs.writeFileSync(tmpFile, Buffer.from(arrayBuf));

    return NextResponse.json({ path: tmpFile });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
