// Small line icons drawn as SVG (never emoji: they look different on every computer).

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG drawing from fixed markup (never from user text). */
export function drawing(viewBox: string, width: number, height: number, markup: string, className = ""): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (className) svg.classList.add(className);
  svg.innerHTML = markup;
  return svg;
}

const line = (d: string, width = 1.4) => `<path d="${d}" stroke="currentColor" stroke-width="${width}"/>`;
const icon = (markup: string, size = 16) => drawing("0 0 16 16", size, size, markup, "line-icon");

export const ICONS = {
  trash: () => icon(line("M2.5 4h11M6 4V2.4h4V4M3.9 4l0.7 9.4c0.05 0.7 0.5 1.1 1.2 1.1h4.4c0.7 0 1.15-0.4 1.2-1.1L12.1 4M6.6 6.8v5M9.4 6.8v5", 1.3)),
  cut: () => icon(`<circle cx="4.4" cy="12" r="2.1" stroke="currentColor" stroke-width="1.3"/><circle cx="11.6" cy="12" r="2.1" stroke="currentColor" stroke-width="1.3"/>${line("M5.9 10.4L11.2 2.2M10.1 10.4L4.8 2.2", 1.3)}`),
  copy: () => icon(`<rect x="5.6" y="5.4" width="8" height="9.1" rx="1.3" stroke="currentColor" stroke-width="1.3"/>${line("M10.6 5.4V3.2c0-0.7-0.6-1.3-1.3-1.3H3.8c-0.7 0-1.3 0.6-1.3 1.3v7.5c0 0.7 0.6 1.3 1.3 1.3h1.8", 1.3)}`),
  paste: () => icon(`<rect x="2.8" y="3" width="10.4" height="11.6" rx="1.4" stroke="currentColor" stroke-width="1.3"/><rect x="5.4" y="1.4" width="5.2" height="3" rx="0.9" fill="currentColor"/>`),
  pastePlain: () => icon(`<rect x="2.8" y="3" width="10.4" height="11.6" rx="1.4" stroke="currentColor" stroke-width="1.3"/><rect x="5.4" y="1.4" width="5.2" height="3" rx="0.9" fill="currentColor"/>${line("M5.6 7.6h4.8M8 7.6v4.8", 1.3)}`),
  format: () => icon(line("M1.6 3.8h7.2M5.2 3.8v9.4M9.4 7.8h5M11.9 7.8v5.4", 1.4)),
  clearFormat: () => icon(`${line("M2.5 3h9M7 3v10", 1.6)}${line("M10.5 10.5l3 3M13.5 10.5l-3 3", 1.4)}`),
};
