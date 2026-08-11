// Minimal stroke icon set

function IconBase({ children, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const IconSparkle = ({ size }) => (
  <IconBase size={size}>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
  </IconBase>
);

const IconGrid = ({ size }) => (
  <IconBase size={size}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </IconBase>
);

const IconLibrary = ({ size }) => (
  <IconBase size={size}>
    <path d="M4 4h4v16H4z" />
    <path d="M10 4h10v5H10z" />
    <path d="M10 11h10v9H10z" />
  </IconBase>
);

const IconCard = ({ size }) => (
  <IconBase size={size}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M2.5 9.5h19" />
  </IconBase>
);

const IconSun = ({ size }) => (
  <IconBase size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </IconBase>
);

const IconMoon = ({ size }) => (
  <IconBase size={size}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </IconBase>
);

const IconArrow = ({ size }) => (
  <IconBase size={size}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </IconBase>
);

const IconCopy = ({ size }) => (
  <IconBase size={size}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </IconBase>
);

const IconDownload = ({ size }) => (
  <IconBase size={size}>
    <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
  </IconBase>
);

const IconCheck = ({ size }) => (
  <IconBase size={size}>
    <path d="M4 12.5l5 5L20 6.5" />
  </IconBase>
);

const IconX = ({ size }) => (
  <IconBase size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </IconBase>
);

const IconBolt = ({ size }) => (
  <IconBase size={size}>
    <path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z" />
  </IconBase>
);

const IconCoins = ({ size }) => (
  <IconBase size={size}>
    <circle cx="9" cy="9" r="5.5" />
    <path d="M14.5 14.5a5.5 5.5 0 1 1-5-5" />
  </IconBase>
);

const IconWand = ({ size }) => (
  <IconBase size={size}>
    <path d="M15 4V2M15 8V6M13 6h-2M19 6h-2M14.5 5.5L13 4M17 4l-1.5 1.5M17 6l1.5 1.5" />
    <path d="M4 19l9-9 2 2-9 9-2-2z" />
  </IconBase>
);

const IconCompare = ({ size }) => (
  <IconBase size={size}>
    <rect x="2.5" y="4" width="8" height="12" rx="1.5" />
    <rect x="13.5" y="8" width="8" height="12" rx="1.5" />
    <path d="M6.5 20v-1M17.5 4v1" />
  </IconBase>
);

const IconRefresh = ({ size }) => (
  <IconBase size={size}>
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 4v4h-4" />
  </IconBase>
);

Object.assign(window, {
  IconSparkle, IconGrid, IconLibrary, IconCard, IconSun, IconMoon, IconArrow,
  IconCopy, IconDownload, IconCheck, IconX, IconBolt, IconCoins, IconWand, IconCompare, IconRefresh,
});
