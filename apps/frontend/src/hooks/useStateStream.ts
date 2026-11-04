import { useEffect } from "react";
import type { StateView } from "@skail-saga/contracts";

/**
 * Follows the demo state through SSE. The stream starts with the current snapshot and sends a new one on every change;
 * EventSource reconnects by itself, so no update is lost.
 */
export function useStateStream(onState: (state: StateView) => void) {
  useEffect(() => {
    const source = new EventSource("/api/stream");
    source.onmessage = (event) => onState(JSON.parse(event.data) as StateView);
    return () => source.close();
    // the callback is a stable state setter; the stream is opened once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
