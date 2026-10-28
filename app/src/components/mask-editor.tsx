"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Paintbrush, Eraser, Trash2, Undo2 } from "lucide-react";

type MaskEditorProps = {
  sourceImageUrl: string;
  onMaskChange: (maskBlobUrl: string | null) => void;
};

export function MaskEditor({ sourceImageUrl, onMaskChange }: MaskEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onMaskChangeRef = useRef(onMaskChange);
  onMaskChangeRef.current = onMaskChange;

  const [brushSize, setBrushSize] = useState(30);
  const [isErasing, setIsErasing] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [history, setHistory] = useState<ImageData[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 400, height: 300 });
  const lastMaskUrlRef = useRef<string | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);

  // Load source image and set canvas size
  useEffect(() => {
    if (!sourceImageUrl) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Scale to fit container (max 400px wide)
      const maxW = 400;
      const scale = Math.min(1, maxW / img.width);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      setCanvasSize({ width: w, height: h });
      setImageLoaded(true);

      // Draw source image on the background canvas
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);

      // Initialize overlay (mask) canvas — transparent
      const overlay = overlayRef.current;
      if (!overlay) return;
      overlay.width = w;
      overlay.height = h;
      const octx = overlay.getContext("2d");
      if (!octx) return;
      octx.clearRect(0, 0, w, h);

      setHistory([]);
      onMaskChangeRef.current(null);
    };
    img.src = sourceImageUrl;
  }, [sourceImageUrl]);

  const saveHistory = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    const data = ctx.getImageData(0, 0, overlay.width, overlay.height);
    setHistory((prev) => [...prev.slice(-20), data]);
  }, []);

  const exportMask = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    // Create a mask canvas: black background, white where painted
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = overlay.width;
    maskCanvas.height = overlay.height;
    const mctx = maskCanvas.getContext("2d");
    if (!mctx) return;

    // Fill black (keep)
    mctx.fillStyle = "#000000";
    mctx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);

    // Read overlay pixels - anywhere with alpha > 0 means painted = white (inpaint)
    const overlayData = ctx.getImageData(0, 0, overlay.width, overlay.height);
    const maskData = mctx.getImageData(0, 0, maskCanvas.width, maskCanvas.height);

    for (let i = 0; i < overlayData.data.length; i += 4) {
      if (overlayData.data[i + 3] > 50) {
        // White = area to inpaint
        maskData.data[i] = 255;
        maskData.data[i + 1] = 255;
        maskData.data[i + 2] = 255;
        maskData.data[i + 3] = 255;
      }
    }
    mctx.putImageData(maskData, 0, 0);

    maskCanvas.toBlob((blob) => {
      if (blob) {
        if (lastMaskUrlRef.current) {
          URL.revokeObjectURL(lastMaskUrlRef.current);
        }
        const url = URL.createObjectURL(blob);
        lastMaskUrlRef.current = url;
        onMaskChangeRef.current(url);
      }
    }, "image/png");
  }, []);

  const getPos = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = overlayRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY,
      };
    },
    [],
  );

  const draw = useCallback(
    (x: number, y: number) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const ctx = overlay.getContext("2d");
      if (!ctx) return;

      ctx.globalCompositeOperation = isErasing
        ? "destination-out"
        : "source-over";
      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      if (isErasing) {
        ctx.fillStyle = "rgba(0,0,0,1)";
      } else {
        ctx.fillStyle = "rgba(255, 80, 80, 0.5)";
      }
      ctx.fill();
    },
    [brushSize, isErasing],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      saveHistory();
      setIsDrawing(true);
      const { x, y } = getPos(e);
      draw(x, y);
    },
    [saveHistory, getPos, draw],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!isDrawing) return;
      const { x, y } = getPos(e);
      draw(x, y);
    },
    [isDrawing, getPos, draw],
  );

  const handleMouseUp = useCallback(() => {
    if (isDrawing) {
      setIsDrawing(false);
      exportMask();
    }
  }, [isDrawing, exportMask]);

  const handleClear = useCallback(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    saveHistory();
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    onMaskChangeRef.current(null);
  }, [saveHistory]);

  const handleUndo = useCallback(() => {
    if (history.length === 0) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    const prev = history[history.length - 1];
    ctx.putImageData(prev, 0, 0);
    setHistory((h) => h.slice(0, -1));
    exportMask();
  }, [history, exportMask]);

  if (!sourceImageUrl) return null;

  return (
    <div className="flex flex-col gap-2 mt-2">
      <Label className="text-xs font-medium">
        Paint the area to change — the red overlay marks what the AI will replace
      </Label>

      {/* Toolbar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Button
          type="button"
          variant={!isErasing ? "default" : "outline"}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setIsErasing(false)}
        >
          <Paintbrush className="w-3 h-3 mr-1" />
          Brush
        </Button>
        <Button
          type="button"
          variant={isErasing ? "default" : "outline"}
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={() => setIsErasing(true)}
        >
          <Eraser className="w-3 h-3 mr-1" />
          Erase
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={handleUndo}
          disabled={history.length === 0}
        >
          <Undo2 className="w-3 h-3 mr-1" />
          Undo
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={handleClear}
        >
          <Trash2 className="w-3 h-3 mr-1" />
          Clear
        </Button>
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
            Size: {brushSize}
          </span>
          <input
            type="range"
            min={5}
            max={80}
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
            className="w-16 h-4 accent-emerald-500"
          />
        </div>
      </div>

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="relative border border-border rounded-md overflow-hidden bg-black/20"
        style={{
          width: "100%",
          maxWidth: canvasSize.width,
          aspectRatio: `${canvasSize.width} / ${canvasSize.height}`,
        }}
      >
        {/* Background: source image */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full"
          style={{ pointerEvents: "none" }}
        />
        {/* Overlay: mask painting */}
        <canvas
          ref={overlayRef}
          className="absolute inset-0 w-full h-full"
          style={{ cursor: "crosshair" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        />
      </div>

      {!imageLoaded && (
        <p className="text-[10px] text-muted-foreground">Loading image...</p>
      )}
    </div>
  );
}
