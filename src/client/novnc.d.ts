declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
    viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean; showDotCursor: boolean; focusOnClick: boolean;
    disconnect(): void; focus(): void; clipboardPasteFrom(text: string): void;
    sendCtrlAltDel(): void;
    addEventListener(type: 'clipboard', listener: (event: CustomEvent<{ text: string }>) => void, options?: boolean | AddEventListenerOptions): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  }
}
