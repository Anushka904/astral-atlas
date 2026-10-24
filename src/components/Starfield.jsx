
import { useEffect, useRef } from "react";

const STAR_COUNT = 105;
const MAX_PIXEL_RATIO = 1.5;
const TARGET_FRAME_INTERVAL = 1000 / 24;

/**
 * Draws a restrained star field behind the landing page.
 *
 * WHY: A canvas avoids creating hundreds of animated DOM nodes.
 * The animation pauses when the tab is hidden to save CPU and battery.
 */
export default function Starfield() {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", {
      alpha: true
    });

    if (!canvas || !context) {
      return undefined;
    }

    let width = 0;
    let height = 0;
    let pixelRatio = 1;
    let animationFrame = 0;
    let running = false;
    let lastDrawTime = 0;

    let stars = [];

    function resizeCanvas() {
      pixelRatio = Math.min(
        window.devicePixelRatio || 1,
        MAX_PIXEL_RATIO
      );

      width = window.innerWidth;
      height = window.innerHeight;

      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      context.setTransform(
        pixelRatio,
        0,
        0,
        pixelRatio,
        0,
        0
      );

      stars = Array.from(
        { length: STAR_COUNT },
        () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          radius: Math.random() * 1.1 + 0.3,
          phase: Math.random() * Math.PI * 2,
          speed: Math.random() * 0.0007 + 0.0002,
          alpha: Math.random() * 0.35 + 0.08
        })
      );

      draw(performance.now());
    }

    function draw(timestamp) {
      context.clearRect(0, 0, width, height);

      for (const star of stars) {
        const pulse =
          0.78 + Math.sin(
            timestamp * star.speed + star.phase
          ) * 0.22;

        const alpha = Math.max(
          0.035,
          star.alpha * pulse
        );

        context.beginPath();
        context.arc(
          star.x,
          star.y,
          star.radius,
          0,
          Math.PI * 2
        );

        context.fillStyle =
          `rgba(237, 227, 209, ${alpha})`;
        context.fill();
      }

      // Connect only nearby stars to suggest a subtle constellation.
      // The bounded star count keeps this pairwise scan inexpensive.
      for (let i = 0; i < stars.length; i += 1) {
        const first = stars[i];

        for (let j = i + 1; j < stars.length; j += 1) {
          const second = stars[j];
          const dx = first.x - second.x;
          const dy = first.y - second.y;
          const distanceSquared = dx * dx + dy * dy;

          if (distanceSquared > 105 * 105) {
            continue;
          }

          const distance = Math.sqrt(distanceSquared);
          const opacity = (1 - distance / 105) * 0.075;

          context.beginPath();
          context.moveTo(first.x, first.y);
          context.lineTo(second.x, second.y);
          context.strokeStyle =
            `rgba(201, 130, 91, ${opacity})`;
          context.lineWidth = 0.6;
          context.stroke();
        }
      }
    }

    function animate(timestamp) {
      if (!running) {
        return;
      }

      if (
        timestamp - lastDrawTime >=
        TARGET_FRAME_INTERVAL
      ) {
        draw(timestamp);
        lastDrawTime = timestamp;
      }

      animationFrame = window.requestAnimationFrame(animate);
    }

    function stopAnimation() {
      running = false;
      window.cancelAnimationFrame(animationFrame);
    }

    function startAnimation() {
      if (running || document.hidden) {
        return;
      }

      running = true;
      lastDrawTime = 0;
      animationFrame = window.requestAnimationFrame(animate);
    }

    function handleVisibilityChange() {
      if (document.hidden) {
        stopAnimation();
      } else {
        startAnimation();
      }
    }

    resizeCanvas();

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );

    if (!reducedMotion.matches) {
      startAnimation();
    }

    function handleMotionPreferenceChange(event) {
      if (event.matches) {
        stopAnimation();
        draw(performance.now());
      } else {
        startAnimation();
      }
    }

    window.addEventListener("resize", resizeCanvas);
    document.addEventListener(
      "visibilitychange",
      handleVisibilityChange
    );
    reducedMotion.addEventListener(
      "change",
      handleMotionPreferenceChange
    );

    return () => {
      stopAnimation();
      window.removeEventListener("resize", resizeCanvas);
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange
      );
      reducedMotion.removeEventListener(
        "change",
        handleMotionPreferenceChange
      );
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="starfield"
      aria-hidden="true"
    />
  );
}
