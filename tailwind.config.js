/** @type {import('tailwindcss').Config} */

// Theme-aware colors: each one reads an RGB triple from a CSS variable that styles.css sets for light (:root) and
// dark (.dark), so one class such as `bg-white` or `text-stone-500` works in both themes. docs/DESIGN.md lists them.
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;
const ramp = (palette, shades) => Object.fromEntries(shades.map((s) => [s, v(`${palette}-${s}`)]));

export default {
  // The second glob is FounderData Pro's dashboard (docs/PRO.md). It matches nothing in a core checkout.
  content: ['./src/dashboard/**/*.{ts,tsx,html}', './pro/dashboard/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', '"Inter Fallback"', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        // One accent word in an onboarding headline (docs/DESIGN.md, Type). Nowhere else.
        serif: ['"Instrument Serif"', '"Iowan Old Style"', 'Georgia', 'serif'],
      },
      // The type scale on top of Tailwind's sizes: display for a page title, stat for a headline number.
      fontSize: {
        display: ['28px', { lineHeight: '34px', letterSpacing: '-0.022em', fontWeight: '600' }],
        title: ['17px', { lineHeight: '24px', letterSpacing: '-0.012em', fontWeight: '600' }],
        stat: ['26px', { lineHeight: '32px', letterSpacing: '-0.025em', fontWeight: '600' }],
        micro: ['11px', { lineHeight: '16px', letterSpacing: '0.04em', fontWeight: '500' }],
        // The onboarding headline: the landing page's calm large type, 40 px on a phone up to 60 px.
        hero: ['clamp(2.5rem, 1.6rem + 3.2vw, 3.75rem)', { lineHeight: '1.02', letterSpacing: '-0.045em', fontWeight: '460' }],
      },
      borderColor: { DEFAULT: v('border-default') },
      colors: {
        white: v('white'),
        paper: v('paper'),
        ink: v('ink'),
        onFill: v('on-fill'),
        visitors: v('visitors'),
        revenue: v('revenue'),
        revenueSoft: v('revenue-soft'),
        visitorsSoft: v('visitors-soft'),
        brand: { DEFAULT: v('brand'), text: v('brand-text'), navy: v('brand-navy'), soft: v('brand-soft') },
        focus: v('focus'),
        stone: ramp('stone', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]),
        amber: ramp('amber', [50, 100, 200, 500, 600, 700, 800, 900]),
        red: ramp('red', [50, 200, 500, 600, 700, 800]),
        emerald: ramp('emerald', [50, 200, 500, 600, 700]),
        violet: ramp('violet', [50, 200, 700]),
        sky: ramp('sky', [50, 200, 700]),
      },
      boxShadow: { card: 'var(--shadow-card)', raised: 'var(--shadow-raised)', pop: 'var(--shadow-pop)', overlay: 'var(--shadow-overlay)' },
      transitionDuration: { DEFAULT: '160ms', fast: '120ms', base: '180ms', slow: '240ms', slower: '320ms' },
      transitionTimingFunction: { DEFAULT: 'var(--ease-out)', out: 'var(--ease-out)', 'in-out': 'var(--ease-in-out)', spring: 'var(--ease-spring)' },
      animation: {
        rise: 'fd-rise var(--dur-slow) var(--ease-out) both',
        fade: 'fd-fade var(--dur-base) var(--ease-out) both',
        'pop-in': 'fd-pop-in var(--dur-base) var(--ease-out) both',
        'dialog-in': 'fd-dialog-in var(--dur-slower) var(--ease-spring) both',
        spin: 'fd-spin 0.7s linear infinite',
        shake: 'fd-shake var(--dur-slower) var(--ease-out)',
      },
    },
  },
  plugins: [],
};
