import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type Dispatch,
  type SetStateAction,
} from 'react';

export function useResponsiveSidebar(): {
  narrow: boolean;
  sidebarOpen: boolean;
  sidebar: RefObject<HTMLElement | null>;
  toggle: RefObject<HTMLButtonElement | null>;
  closeNavigation: () => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
} {
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 760);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 760);
  const sidebar = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const closeNavigation = (): void => {
    setSidebarOpen(false);
    requestAnimationFrame(() => toggle.current?.focus());
  };
  useEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const update = (): void => {
      setNarrow(media.matches);
      setSidebarOpen(!media.matches);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!narrow || !sidebarOpen) return;
    sidebar.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
    };
  }, [narrow, sidebarOpen]);
  return {
    narrow,
    sidebarOpen,
    sidebar,
    toggle,
    closeNavigation,
    setSidebarOpen,
  };
}
