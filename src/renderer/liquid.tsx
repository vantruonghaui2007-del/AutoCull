import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/*
 * "Liquid glass" layer for the UI: purely visual, no app state.
 * - LiquidDefs: an SVG lens filter (edge refraction) used by `backdrop-filter` on floating glass surfaces.
 * - useLiquidPointer: one document listener that feeds the pointer position to the glass under it
 *   (specular highlight) and starts a short ripple on pressed buttons.
 * - LiquidSeg: segmented control whose active "drop" slides and stretches between options.
 */

// Displacement map: red ramps left→right, green top→bottom, a blurred neutral (128,128) core.
// Only the rim bends what is behind the glass, like the edge of a lens.
const LENS_MAP = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" preserveAspectRatio="none">
  <defs>
    <linearGradient id="r" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#f00"/></linearGradient>
    <linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#0f0"/></linearGradient>
    <filter id="b" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="9"/></filter>
  </defs>
  <rect width="200" height="200" fill="url(#r)"/>
  <rect width="200" height="200" fill="url(#g)" style="mix-blend-mode:screen"/>
  <rect x="22" y="22" width="156" height="156" rx="34" fill="rgb(128,128,0)" filter="url(#b)"/>
</svg>`,
)}`;

export function LiquidDefs() {
  return (
    <svg className="liquid-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <filter id="lg-lens" x="0" y="0" width="100%" height="100%" primitiveUnits="objectBoundingBox" colorInterpolationFilters="sRGB">
        <feImage href={LENS_MAP} x="0" y="0" width="1" height="1" preserveAspectRatio="none" result="map" />
        <feDisplacementMap in="SourceGraphic" in2="map" scale="0.06" xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}

/** Pointer-following highlight on `.lg` surfaces and a press ripple on buttons. */
export function useLiquidPointer() {
  useEffect(() => {
    let frame = 0;
    let last: PointerEvent | null = null;
    const paint = () => {
      frame = 0;
      const e = last;
      if (!e || !(e.target instanceof Element)) return;
      const el = e.target.closest<HTMLElement>('.lg, button');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    const onMove = (e: PointerEvent) => {
      last = e;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      const b = e.target.closest<HTMLButtonElement>('button');
      if (!b || b.disabled) return;
      const r = b.getBoundingClientRect();
      b.style.setProperty('--rx', `${e.clientX - r.left}px`);
      b.style.setProperty('--ry', `${e.clientY - r.top}px`);
      b.removeAttribute('data-ripple');
      void b.offsetWidth; // restart the animation
      b.setAttribute('data-ripple', '');
    };
    const onEnd = (e: AnimationEvent) => {
      if (e.animationName === 'lg-ripple' && e.target instanceof Element) e.target.removeAttribute('data-ripple');
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('animationend', onEnd);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('animationend', onEnd);
    };
  }, []);
}

/** Segmented control: children are buttons, the one with class `on` gets the sliding liquid drop. */
export function LiquidSeg(props: { children: ReactNode; className?: string; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const drop = useRef<HTMLSpanElement>(null);
  const prevX = useRef<number | null>(null);

  const place = () => {
    const el = box.current;
    const d = drop.current;
    if (!el || !d) return;
    const on = el.querySelector<HTMLElement>(':scope > button.on');
    if (!on) {
      d.style.opacity = '0';
      prevX.current = null;
      return;
    }
    const x = on.offsetLeft;
    d.style.opacity = '1';
    d.style.width = `${on.offsetWidth}px`;
    d.style.height = `${on.offsetHeight}px`;
    d.style.transform = `translate(${x}px, ${on.offsetTop}px)`;
    d.dataset.tone = [...on.classList].find((c) => c.startsWith('list-')) ?? '';
    if (prevX.current !== null && prevX.current !== x) {
      d.classList.remove('moving');
      void d.offsetWidth;
      d.classList.add('moving');
    }
    prevX.current = x;
  };

  // After every render: the active option or its label (counts) may have changed.
  useLayoutEffect(place);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => place());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className={`seg lg${props.className ? ` ${props.className}` : ''}`} role="tablist" aria-label={props.label} ref={box}>
      <span className="seg-drop" ref={drop} aria-hidden="true" onAnimationEnd={(e) => e.currentTarget.classList.remove('moving')} />
      {props.children}
    </div>
  );
}
