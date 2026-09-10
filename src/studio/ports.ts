import { falWmaOpener, createWmaTransport, type DirectorTransport } from '../stream/transport';
import { fal, uploadFile } from '../fal';
import { MULTI_ANGLE_ENDPOINT, type MultiAngleInput } from '../angle/multiAngle';
import { createFrameExtractor } from '../angle/extract';
import { createMusicBedPorts } from '../audio/musicBed';
import { renderBlot } from '../ink/render';
import { remuxToMp4 } from '../api/client';
import type { StudioOptions } from './studio';

/** The parts of the studio that talk to the outside world. */
export type StudioRuntimePorts = Pick<
  StudioOptions,
  | 'transport'
  | 'vision'
  | 'multiAngleSubscribe'
  | 'upload'
  | 'render'
  | 'extractArrivalFrame'
  | 'fetchTrack'
  | 'probeDuration'
  | 'remux'
>;

/**
 * Real implementations: fal through the local proxy, vision through our own
 * express route, frames read back through the same-origin media relay.
 *
 * FAL_KEY stays on the server: every call here names an upstream URL and lets
 * the proxy attach the credential.
 */
export function createRuntimePorts(): StudioRuntimePorts {
  const musicPorts = createMusicBedPorts();
  const extractor = createFrameExtractor();
  return {
    transport: createWmaTransport(falWmaOpener(fal)) as DirectorTransport,
    vision: {
      async call({ imageDataUri, model, visionPrompt }) {
        const response = await fetch('/api/interpret', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: imageDataUri, model, visionPrompt }),
        });
        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `vision call failed (${response.status})`);
        }
        return ((await response.json()) as { text: string }).text;
      },
    },
    async multiAngleSubscribe(input: MultiAngleInput) {
      const result = await fal.subscribe(MULTI_ANGLE_ENDPOINT, { input });
      return result.data;
    },
    upload: (blob, name) => uploadFile(blob, name),
    render: (recipe) => renderBlot(recipe),
    extractArrivalFrame: (videoUrl) => extractor.extractArrivalFrame(videoUrl),
    fetchTrack: (url) => musicPorts.fetchTrack(url),
    probeDuration: (blob) => musicPorts.probeDurationSeconds(blob),
    remux: (blob) => remuxToMp4(blob),
  };
}
