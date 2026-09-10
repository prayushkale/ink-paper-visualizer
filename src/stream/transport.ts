import type { FalClient } from '@fal-ai/client';
import { wma, type WmaReceiveTrack } from '@fal-ai/client/realtime';
import { DIRECTOR_ENDPOINT } from './protocol';

/** Coarse lifecycle the managed realtime handle reports. */
export type RealtimeStateName = 'opening' | 'live' | 'failed' | 'closed';

export interface DirectorConnection {
  send(message: unknown): void;
  close(): Promise<void>;
}

export interface TransportHandlers {
  onData(raw: string): void;
  onState(state: RealtimeStateName): void;
  onError(error: unknown): void;
  onMedia?(stream: MediaStream): void;
}

/** The seam between the app and WMA, so a session can be faked in tests. */
export interface DirectorTransport {
  open(handlers: TransportHandlers): DirectorConnection;
}

export interface WmaOpenArgs extends TransportHandlers {
  endpoint: string;
  /** We receive video and audio and send none: the stream is the output. */
  receive: readonly WmaReceiveTrack[];
}

export type WmaOpener = (args: WmaOpenArgs) => DirectorConnection;

/**
 * Wraps a WMA opener. The Director session is a WebRTC peer, not a queued
 * request, so `receive` must declare both tracks before the offer is created.
 */
export function createWmaTransport(opener: WmaOpener, endpoint: string = DIRECTOR_ENDPOINT): DirectorTransport {
  return {
    open(handlers) {
      // Both tracks must be declared before the offer is created: WebRTC
      // answers cannot introduce media sections the browser did not offer.
      return opener({ endpoint, receive: ['video', 'audio'] as const, ...handlers });
    },
  };
}

interface ManagedSessionLike {
  readonly state?: RealtimeStateName;
  session?: { state?: RealtimeStateName };
  send(message: unknown): void;
  close(): Promise<void>;
}

/** The real opener: `fal.realtime.open(wma(endpoint), {...})`. */
export function falWmaOpener(client: FalClient): WmaOpener {
  return ({ endpoint, receive, onData, onState, onError, onMedia }) => {
    const handle = client.realtime.open(wma(endpoint), {
      receive: [...receive],
      onData,
      onState,
      onError,
      onMedia,
    }) as unknown as ManagedSessionLike;
    if (!handle) throw new Error(`could not open a realtime session on ${endpoint}`);
    return {
      send(message: unknown) {
        handle.send(message);
      },
      async close() {
        await handle.close();
      },
    };
  };
}
