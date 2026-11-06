export const HeartIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16">
    <path d="M8 14S1.5 9.8 1.5 5.6A3.3 3.3 0 0 1 8 4a3.3 3.3 0 0 1 6.5 1.6C14.5 9.8 8 14 8 14Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);
export const SearchIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16">
    <path d="M7 2a5 5 0 1 0 0 10A5 5 0 0 0 7 2Zm4 9 3 3" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
export const FullscreenIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16">
    <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
export const PlayIcon = ({ size = 14 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width={size} height={size}>
    <path d="M4 2v12l10-6z" fill="currentColor" />
  </svg>
);
export const LogoMark = () => <img src="/favicon.svg" alt="" width="24" height="24" className="logo-mark" />;

const tab = { viewBox: "0 0 20 20", width: 22, height: 22, "aria-hidden": true, fill: "none", stroke: "currentColor", strokeWidth: 1.7 } as const;
export const HomeIcon = () => (
  <svg {...tab}><path d="M3 9.5 10 3l7 6.5V17h-4.5v-4.5h-5V17H3z" strokeLinejoin="round" /></svg>
);
export const HeartTabIcon = () => (
  <svg {...tab}><path d="M10 17s-7-4.4-7-9.2A3.8 3.8 0 0 1 10 5.6a3.8 3.8 0 0 1 7 2.2C17 12.6 10 17 10 17Z" strokeLinejoin="round" /></svg>
);
export const ListIcon = () => (
  <svg {...tab}><path d="M3 4h14M3 10h14M3 16h14" /></svg>
);
export const PlusIcon = () => (
  <svg {...tab}><path d="M10 3.5v13M3.5 10h13" /></svg>
);
export const KeyIcon = () => (
  <svg {...tab}><path d="M3 16.5 9.3 10.2M7 14.5l2 2M12.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" /></svg>
);
export const CloseIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="18" height="18"><path d="M3 3l10 10M13 3 3 13" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>
);
export const ShareIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16"><path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M3 9v5h10V9" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
);
