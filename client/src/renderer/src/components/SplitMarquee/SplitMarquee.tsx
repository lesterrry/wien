import { useEffect, useRef } from "react";
import styles from "./SplitMarquee.module.css";

const REVERSE = true;
const SPEED = 24;
const STRETCH = 6;
const STRIPE_WIDTH = 2;
const STRIPE_GAP = 1.75;

export function SplitMarquee({
  text,
  paused = true,
}: {
  text: string;
  paused?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  const updatePlaybackRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    pausedRef.current = paused;
    updatePlaybackRef.current?.();
  }, [paused]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const texture = document.createElement("canvas");
    const source = texture.getContext("2d");
    if (!source) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let period = 1;
    let distance = 0;
    let previousTime: number | undefined;
    let frame = 0;
    let disposed = false;

    function draw() {
      if (!context || !canvas || !width || !height) return;
      context.clearRect(0, 0, width, height);
      if (!text.trim()) return;

      const center = width / 2;
      const progress = distance % period;
      const phase = REVERSE ? (period - progress) % period : progress;

      // Reduced motion keeps a readable, stationary wordmark.
      if (reducedMotion.matches) {
        context.drawImage(
          texture,
          0,
          0,
          period * pixelRatio,
          texture.height,
          0,
          0,
          period,
          height,
        );
        return;
      }

      context.save();
      context.beginPath();
      context.rect(center, 0, width - center, height);
      context.clip();
      // The ordinary line travels right, or toward the center when reversed.
      for (let x = center + phase - period; x < width; x += period) {
        context.drawImage(
          texture,
          0,
          0,
          period * pixelRatio,
          texture.height,
          x,
          0,
          period,
          height,
        );
      }
      context.restore();

      // Both halves sample -phase at the center. Mirror the drawing axis
      // so the same glyphs meet at the center in either playback direction.
      context.save();
      context.translate(center, 0);
      context.scale(-1, 1);
      for (let x = 0; x < center; x += STRIPE_WIDTH + STRIPE_GAP) {
        const offset = x / STRETCH - phase;
        const sourceX = ((offset % period) + period) % period;
        context.drawImage(
          texture,
          sourceX * pixelRatio,
          0,
          (STRIPE_WIDTH / STRETCH) * pixelRatio,
          texture.height,
          x,
          0,
          STRIPE_WIDTH,
          height,
        );
      }
      context.restore();
    }

    function resize() {
      if (!canvas || !context || !source) return;
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      if (!width || !height) return;

      pixelRatio = window.devicePixelRatio || 1;
      canvas.width = Math.ceil(width * pixelRatio);
      canvas.height = Math.ceil(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      const style = getComputedStyle(canvas);
      const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      source.font = font;
      const firstWord = text.match(/^\s*\S+/)?.[0] ?? text;
      const remainder = text.slice(firstWord.length);
      const firstWordWidth = source.measureText(firstWord).width;
      // At rest, keep the next word beyond the right edge. The padding is
      // part of the texture, so starting playback does not change the frame.
      const remainderX = Math.max(firstWordWidth, width / 2);
      const textWidth = remainder
        ? remainderX + source.measureText(remainder).width
        : firstWordWidth;
      period = Math.max(
        1,
        Math.ceil(textWidth + parseFloat(style.fontSize)),
      );
      // Two copies allow a stripe to straddle the repeat boundary.
      texture.width = Math.ceil(period * 2 * pixelRatio);
      texture.height = canvas.height;
      source.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      source.font = font;
      source.fillStyle = style.color;
      source.textBaseline = "middle";
      for (const x of [0, period]) {
        source.fillText(firstWord, x, height / 2);
        source.fillText(remainder, x + remainderX, height / 2);
      }
      draw();
    }

    function animate(time: number) {
      if (previousTime !== undefined) {
        distance =
          (distance + (Math.min(time - previousTime, 64) / 1000) * SPEED) %
          period;
      }
      previousTime = time;
      if (pixelRatio !== window.devicePixelRatio) resize();
      draw();
      frame = requestAnimationFrame(animate);
    }

    function updatePlayback() {
      cancelAnimationFrame(frame);
      previousTime = undefined;
      draw();
      if (
        !pausedRef.current &&
        !document.hidden &&
        !reducedMotion.matches &&
        text.trim()
      ) {
        frame = requestAnimationFrame(animate);
      }
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    updatePlaybackRef.current = updatePlayback;
    resize();
    updatePlayback();
    reducedMotion.addEventListener("change", updatePlayback);
    document.addEventListener("visibilitychange", updatePlayback);
    void document.fonts.ready.then(() => {
      if (!disposed) resize();
    });

    return () => {
      disposed = true;
      updatePlaybackRef.current = null;
      cancelAnimationFrame(frame);
      observer.disconnect();
      reducedMotion.removeEventListener("change", updatePlayback);
      document.removeEventListener("visibilitychange", updatePlayback);
    };
  }, [text]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.canvas}
      role="img"
      aria-label={text}
    >
      {text}
    </canvas>
  );
}
