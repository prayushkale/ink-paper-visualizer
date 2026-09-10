export {};

declare global {
  interface Window {
    lastInterpretation?: string;
    lastError?: string;
  }
}
