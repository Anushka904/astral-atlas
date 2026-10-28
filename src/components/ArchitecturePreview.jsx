import { useEffect, useRef, useState } from "react";

const CONNECTIONS = [
  { id: "entry-client", d: "M236 208 C286 208 292 92 350 92", label: "exports" },
  { id: "entry-request", d: "M236 208 C286 208 292 210 350 210", label: "dispatches" },
  { id: "entry-config", d: "M236 208 C286 208 292 328 350 328", label: "configures" },
  { id: "client-fetch", d: "M534 92 C606 92 624 144 702 144", label: "selects" },
  { id: "request-http", d: "M534 210 C606 210 624 262 702 262", label: "sends" },
  { id: "config-utils", d: "M534 328 C606 328 624 358 702 358", label: "uses" },
  { id: "request-utils", d: "M534 210 C610 210 616 358 702 358", label: "transforms", dashed: true }
];

const NODES = [
  { id: "entry", x: 54, y: 170, w: 182, h: 76, title: "Application entry", path: "src/index.js", tone: "violet" },
  { id: "client", x: 350, y: 56, w: 184, h: 72, title: "Client API", path: "lib/axios.js", tone: "violet" },
  { id: "request", x: 350, y: 174, w: 184, h: 72, title: "Request pipeline", path: "core/dispatchRequest.js", tone: "cyan" },
  { id: "config", x: 350, y: 292, w: 184, h: 72, title: "Defaults & config", path: "lib/defaults.js", tone: "pink" },
  { id: "fetch", x: 702, y: 108, w: 190, h: 72, title: "Fetch adapter", path: "adapters/fetch.js", tone: "cyan" },
  { id: "http", x: 702, y: 226, w: 190, h: 72, title: "HTTP adapter", path: "adapters/http.js", tone: "pink" },
  { id: "utils", x: 702, y: 322, w: 190, h: 60, title: "URL helpers", path: "helpers/url.js", tone: "violet" }
];

/**
 * Decorative, illustrative architecture graph. It contains no live repository
 * metrics; its paths animate only when the preview scrolls into view.
 */
export default function ArchitecturePreview() {
  const sectionRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const element = sectionRef.current;
    if (!element) return undefined;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );

    if (
      reducedMotion.matches ||
      typeof IntersectionObserver !== "function"
    ) {
      setIsVisible(true);
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;

      setIsVisible(true);
      observer.disconnect();
    }, {
      threshold: 0.22,
      rootMargin: "0px 0px -5% 0px"
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <section
      ref={sectionRef}
      className={`aa-architecture-preview ${isVisible ? "aa-preview-is-visible" : ""}`}
      aria-labelledby="aa-preview-title"
    >
      <div className="aa-preview-heading">
        <div>
          <p className="aa-eyebrow">A CLOSER LOOK</p>
          <h2 id="aa-preview-title">From tangled imports to a map you can read.</h2>
          <p>
            Follow the connections between entry points, request pipelines,
            adapters and utilities—before you make your first change.
          </p>
        </div>
        <span className="aa-preview-disclaimer">ILLUSTRATIVE GRAPH</span>
      </div>

      <div className="aa-preview-window">
        <div className="aa-preview-windowbar">
          <span className="aa-preview-window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="aa-preview-window-path">repository-map / dependency-graph</span>
          <span className="aa-preview-window-status">
            <i aria-hidden="true" />
            STATIC PREVIEW
          </span>
        </div>

        <svg
          className="aa-preview-graph"
          viewBox="0 0 960 420"
          role="img"
          aria-labelledby="aa-preview-svg-title aa-preview-svg-description"
          preserveAspectRatio="xMidYMid meet"
        >
          <title id="aa-preview-svg-title">Illustrative source-code dependency graph</title>
          <desc id="aa-preview-svg-description">
            Seven modules connected by import relationships. Connections draw
            in sequence and module cards appear as the preview enters the viewport.
          </desc>

          <defs>
            <pattern id="aa-preview-grid" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="1" fill="#66708c" fillOpacity="0.23" />
            </pattern>
            <linearGradient id="aa-preview-edge-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#A78BFA" />
              <stop offset="100%" stopColor="#67E8F9" />
            </linearGradient>
            <marker id="aa-preview-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#67E8F9" />
            </marker>
            <filter id="aa-preview-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect width="960" height="420" fill="url(#aa-preview-grid)" />
          <rect className="aa-preview-zone" x="32" y="140" width="228" height="136" rx="14" />
          <rect className="aa-preview-zone" x="326" y="30" width="232" height="350" rx="14" />
          <rect className="aa-preview-zone" x="680" y="80" width="234" height="322" rx="14" />
          <text className="aa-preview-zone-label" x="44" y="128">ENTRY</text>
          <text className="aa-preview-zone-label" x="340" y="18">CORE</text>
          <text className="aa-preview-zone-label" x="694" y="68">TRANSPORT & UTILITIES</text>

          <g className="aa-preview-connections" aria-hidden="true">
            {CONNECTIONS.map((connection, index) => (
              <path
                key={connection.id}
                className={`aa-preview-edge ${connection.dashed ? "aa-preview-edge-dashed" : ""}`}
                d={connection.d}
                pathLength={1}
                markerEnd="url(#aa-preview-arrow)"
                style={{ "--draw-delay": `${index * 115}ms` }}
              />
            ))}
          </g>

          <g className="aa-preview-nodes">
            {NODES.map((node, index) => (
              <g
                key={node.id}
                className={`aa-preview-node aa-preview-node-${node.tone}`}
                style={{ "--node-delay": `${460 + index * 85}ms` }}
              >
                <rect
                  x={node.x}
                  y={node.y}
                  width={node.w}
                  height={node.h}
                  rx="10"
                />
                <circle cx={node.x + 17} cy={node.y + 20} r="4" />
                <text
                  className="aa-preview-node-title"
                  x={node.x + 29}
                  y={node.y + 24}
                >
                  {node.title}
                </text>
                <text
                  className="aa-preview-node-path"
                  x={node.x + 14}
                  y={node.y + (node.h > 65 ? 49 : 43)}
                >
                  {node.path}
                </text>
              </g>
            ))}
          </g>

          <g className="aa-preview-pulse" aria-hidden="true" filter="url(#aa-preview-glow)">
            <circle cx="274" cy="208" r="3" />
            <circle cx="615" cy="210" r="3" />
          </g>
        </svg>

        <div className="aa-preview-window-footer">
          <span><i className="aa-preview-footer-violet" /> Module relationships</span>
          <span><i className="aa-preview-footer-cyan" /> Import direction</span>
          <span>This is a visual example, not analysis data.</span>
        </div>
      </div>
    </section>
  );
}
