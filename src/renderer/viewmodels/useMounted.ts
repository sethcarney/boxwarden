import { useEffect, useRef } from 'react';

/**
 * False once the component is gone.
 *
 * Every ViewModel here awaits the bridge, and a call started before unmount
 * still resolves afterwards — setting state on that result is a leak. The poll
 * runs every five seconds, so this is not a theoretical window.
 *
 * A ref rather than state on purpose: reading it must not itself cause a
 * render, and it is only ever consulted inside an async continuation.
 */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
