import { useCallback, useEffect, useState, type MouseEvent } from 'react';

type View = 'machines' | 'history' | 'telegram' | 'box';
interface PanelRoute { view: View; selected: string }

function readRoute(): PanelRoute {
  const url = new URL(window.location.href);
  if (url.pathname === '/history' || url.pathname === '/telegram' || url.pathname === '/box') {
    return { view: url.pathname.slice(1) as View, selected: url.searchParams.get('account') || 'all' };
  }
  const account = url.pathname.match(/^\/accounts\/([^/]+)\/?$/);
  try { return { view: 'machines', selected: account ? decodeURIComponent(account[1]) : 'all' }; }
  catch { return { view: 'machines', selected: 'all' }; }
}

export function panelPath({ view, selected }: PanelRoute) {
  if (view === 'machines') return selected === 'all' ? '/machines' : '/accounts/' + encodeURIComponent(selected);
  return '/' + view + (selected === 'all' ? '' : '?' + new URLSearchParams({ account: selected }));
}

export function usePanelRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const sync = () => {
      const next = readRoute();
      const path = panelPath(next);
      if (location.pathname + location.search !== path) window.history.replaceState(null, '', path);
      setRoute(next);
    };
    sync();
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const navigate = useCallback((next: PanelRoute, replace = false) => {
    const path = panelPath(next);
    if (location.pathname + location.search !== path) {
      window.history[replace ? 'replaceState' : 'pushState'](null, '', path);
    }
    setRoute(next);
  }, []);
  const link = (next: PanelRoute) => ({
    href: panelPath(next),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      navigate(next);
    },
  });
  return { route, navigate, link };
}
