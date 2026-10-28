import { useEffect } from "react";

/**
 * Adds lightweight, one-time viewport reveals to the existing landing page.
 * The component renders no UI and never touches repository analysis state.
 */
const REVEAL_SELECTORS = [
  ".aa-landing-header",
  ".aa-hero h1",
  ".aa-hero-description",
  ".aa-hero-actions",
  ".aa-landing-error",
  ".aa-input-card",
  ".aa-architecture-preview",
  ".aa-samples-section > .aa-section-heading",
  ".aa-sample-card",
  ".aa-how-section > .aa-how-heading",
  ".aa-how-card",
  ".aa-privacy-section",
  ".aa-landing-footer"
];

function revealDelay(element, index) {
  if (element.matches(".aa-sample-card, .aa-how-card")) {
    return `${(index % 3) * 85}ms`;
  }

  if (element.matches(".aa-hero h1")) return "40ms";
  if (element.matches(".aa-hero-description")) return "120ms";
  if (element.matches(".aa-hero-actions")) return "180ms";
  if (element.matches(".aa-input-card")) return "240ms";

  return "0ms";
}

export default function LandingMotion() {
  useEffect(() => {
    const root = document.querySelector(
      ".aa-app-root.aa-landing-page"
    );

    if (!root) return undefined;

    const elements = [...new Set(
      REVEAL_SELECTORS.flatMap((selector) =>
        [...root.querySelectorAll(selector)]
      )
    )];

    elements.forEach((element, index) => {
      element.classList.add("aa-scroll-reveal");
      element.style.setProperty(
        "--reveal-delay",
        revealDelay(element, index)
      );
    });

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );

    let observer = null;

    if (
      reducedMotion.matches ||
      typeof IntersectionObserver !== "function"
    ) {
      elements.forEach((element) => {
        element.classList.add("aa-scroll-visible");
      });
    } else {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;

          entry.target.classList.add("aa-scroll-visible");
          observer.unobserve(entry.target);
        }
      }, {
        root: null,
        rootMargin: "0px 0px -8% 0px",
        threshold: 0.12
      });

      elements.forEach((element) => observer.observe(element));
    }

    const hero = root.querySelector(".aa-hero");
    let frameId = 0;

    function updateParallax() {
      frameId = 0;

      if (!hero || reducedMotion.matches) {
        root.style.setProperty("--hero-parallax-y", "0px");
        return;
      }

      const bounds = hero.getBoundingClientRect();
      const offset = Math.max(
        -24,
        Math.min(24, (window.innerHeight * 0.42 - bounds.top) * 0.055)
      );

      root.style.setProperty(
        "--hero-parallax-y",
        `${offset.toFixed(2)}px`
      );
    }

    function scheduleParallax() {
      if (frameId === 0) {
        frameId = window.requestAnimationFrame(updateParallax);
      }
    }

    function handleMotionPreference() {
      if (reducedMotion.matches) {
        root.style.setProperty("--hero-parallax-y", "0px");
      } else {
        scheduleParallax();
      }
    }

    window.addEventListener("scroll", scheduleParallax, { passive: true });
    window.addEventListener("resize", scheduleParallax, { passive: true });
    reducedMotion.addEventListener("change", handleMotionPreference);
    scheduleParallax();

    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", scheduleParallax);
      window.removeEventListener("resize", scheduleParallax);
      reducedMotion.removeEventListener("change", handleMotionPreference);

      if (frameId !== 0) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, []);

  return null;
}
