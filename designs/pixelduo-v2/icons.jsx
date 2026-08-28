// icons.jsx — Phosphor 风格线性图标 (1.8 stroke, 统一 family)
const I = ({ d, size = 18, sw = 1.8, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d ? <path d={d} /> : children}
  </svg>
);

const Sparkle = ({ size }) => (
  <I size={size}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M19 15l.9 2.4L22 18.3l-2.1.9L19 21.5l-.9-2.3-2.1-.9 2.1-.9L19 15z" />
  </I>
);
const ArrowRight = ({ size }) => <I size={size} d="M5 12h14M13 6l6 6-6 6" />;
const ArrowLeftRight = ({ size }) => <I size={size} d="M8 7L4 11l4 4M16 7l4 4-4 4M4 11h16" />;
const Bolt = ({ size }) => <I size={size} d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />;
const Check = ({ size }) => <I size={size} d="M4 12.5l5 5L20 6.5" />;
const Image = ({ size }) => (
  <I size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="9" cy="10" r="1.8" />
    <path d="M21 16l-5-5-9 9" />
  </I>
);
const Wallet = ({ size }) => (
  <I size={size}>
    <rect x="3" y="6" width="18" height="14" rx="2.5" />
    <path d="M3 10h18M16 15h2" />
  </I>
);
const Wand = ({ size }) => (
  <I size={size}>
    <path d="M6 18L18 6M14 6h4v4" />
    <path d="M5 5l.01 0M9 3l.01 0M3 9l.01 0" />
  </I>
);
const Coin = ({ size }) => (
  <I size={size}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8v8M9.5 10c0-1 1-1.8 2.5-1.8s2.5.8 2.5 1.8-1 1.5-2.5 1.9-2.5.9-2.5 1.9 1 1.8 2.5 1.8 2.5-.8 2.5-1.8" />
  </I>
);
const Grid = ({ size }) => (
  <I size={size}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </I>
);
const Play = ({ size }) => <I size={size} d="M7 5.5v13l11-6.5-11-6.5z" />;
const Chevron = ({ size }) => <I size={size} d="M9 6l6 6-6 6" />;

Object.assign(window, { Sparkle, ArrowRight, ArrowLeftRight, Bolt, Check, Image, Wallet, Wand, Coin, Grid, Play, Chevron });
