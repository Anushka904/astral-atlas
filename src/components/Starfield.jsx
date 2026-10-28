/**
 * Lightweight canvas starfield for the Astral Atlas landing page.
 *
 * WHY:
 * - Canvas avoids creating hundreds of DOM elements.
 * - Device pixel ratio is capped to reduce GPU and memory cost.
 * - Animation pauses when the document is hidden.
 * - Reduced-motion users receive a static star field.
 * - Colours match the graphite, violet and cyan landing palette.
 */

import { useEffect, useRef } from "react";

const STAR_COLOURS = [
  "#EDE9FE",
  "#C4B5FD",
  "#67E8F9",
  "#F9A8D4"
];

export default function Starfield() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;

    if (!canvas || !host) {
      return undefined;
    }

    const context = canvas.getContext("2d", { alpha: true });

    if (!context) {
      return undefined;
    }

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );

    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let stars = [];
    let frameId = 0;
    let active = true;
    let lastFrame = 0;

    function createStars() {
      const area = width * height;
      const count = Math.max(55, Math.min(260, Math.floor(area / 9500)));

      stars = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: 0.35 + Math.random() * 1.15,
        alpha: 0.18 + Math.random() * 0.54,
        phase: Math.random() * Math.PI * 2,
        speed: 0.0003 + Math.random() * 0.0008,
        colour: STAR_COLOURS[
          Math.floor(Math.random() * STAR_COLOURS.length)
        ]
      }));
    }

    function resize() {
      const documentWidth = Math.max(
        document.documentElement.clientWidth,
        window.innerWidth
      );

      const documentHeight = Math.max(
        document.documentElement.scrollHeight,
        window.innerHeight
      );

      const bounds = host.getBoundingClientRect();

      width = Math.max(documentWidth, bounds.width);
      height = Math.max(documentHeight, bounds.height, window.innerHeight);
      pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);

      canvas.width = Math.ceil(width * pixelRatio);
      canvas.height = Math.ceil(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      createStars();
      drawStatic();
    }

    function drawStatic() {
      context.clearRect(0, 0, width, height);

      for (const star of stars) {
        context.globalAlpha = star.alpha;
        context.fillStyle = star.colour;
        context.beginPath();
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
    }

    function animate(time) {
      if (!active) return;

      if (
        reducedMotion.matches ||
        document.visibilityState === "hidden"
      ) {
        drawStatic();
        frameId = 0;
        return;
      }

      // Decorative twinkling is capped near 30 FPS to avoid needless work.
      if (time - lastFrame < 33) {
        frameId = requestAnimationFrame(animate);
        return;
      }

      lastFrame = time;
      context.clearRect(0, 0, width, height);

      for (const star of stars) {
        const alpha = star.alpha * (
          0.72 + Math.sin(time * star.speed + star.phase) * 0.28
        );

        context.globalAlpha = Math.max(0.08, Math.min(0.8, alpha));
        context.fillStyle = star.colour;
        context.beginPath();
        context.arc(star.x, star.y, star.radius, 0, Math.PI * 2);
        context.fill();
      }

      context.globalAlpha = 1;
      frameId = requestAnimationFrame(animate);
    }

    function startAnimation() {
      if (!active || frameId) return;

      if (
        reducedMotion.matches ||
        document.visibilityState === "hidden"
      ) {
        drawStatic();
        return;
      }

      frameId = requestAnimationFrame(animate);
    }

    function stopAnimation() {
      if (frameId) {
        cancelAnimationFrame(frameId);
        frameId = 0;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "hidden") {
        stopAnimation();
        drawStatic();
      } else {
        startAnimation();
      }
    }

    function handleMotionPreference() {
      stopAnimation();
      drawStatic();

      if (!reducedMotion.matches) {
        startAnimation();
      }
    }

    resize();
    startAnimation();

    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", handleVisibility);
    reducedMotion.addEventListener("change", handleMotionPreference);

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(resize)
      : null;

    resizeObserver?.observe(host);

    return () => {
      active = false;
      stopAnimation();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", handleVisibility);
      reducedMotion.removeEventListener("change", handleMotionPreference);
      context.clearRect(0, 0, width, height);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="aa-starfield-canvas"
      aria-hidden="true"
    />
  );
}
