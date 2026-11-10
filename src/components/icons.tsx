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
/** Two players: multiplayer, playing with friends. */
export const PeopleIcon = ({ size = 16 }: { size?: number }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width={size} height={size}><path d="M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.5 13.5c.4-2.4 2.1-3.7 4.5-3.7s4.1 1.3 4.5 3.7M10.5 7.2a2.2 2.2 0 1 0-.6-4.3M12 9.9c1.4.4 2.3 1.6 2.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
);
export const ShareIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16"><path d="M8 10V2M4.5 5.5 8 2l3.5 3.5M3 9v5h10V9" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
);
export const UserIcon = () => (
  <svg {...tab}><path d="M10 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3.5 17.5c.8-3.3 3.3-5 6.5-5s5.7 1.7 6.5 5" strokeLinejoin="round" /></svg>
);
export const BellIcon = () => (
  <svg {...tab}><path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 2h-13zM8.2 17.5a2 2 0 0 0 3.6 0" strokeLinejoin="round" /></svg>
);
export const BubbleIcon = () => (
  <svg {...tab}><path d="M3 4h14v10H8l-4 3.5V14H3z" strokeLinejoin="round" /></svg>
);
export const ChatIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13"><path d="M2 3h12v8H7l-3 3v-3H2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
);
export const LockIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="11" height="11"><path d="M4 7V5a4 4 0 0 1 8 0v2M3 7h10v7H3z" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
);
export const LogoutIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" width="16" height="16"><path d="M6 2H2.5v12H6M10.5 4.5 14 8l-3.5 3.5M14 8H6" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
);
