/**
 * noVNC ships no types. Only the surface this panel uses is declared, so a call it does not make is
 * a compile error rather than `any` spreading out through the viewer.
 */
declare module "@novnc/novnc" {
  interface Credentials {
    username?: string;
    password?: string;
    target?: string;
  }

  interface Options {
    credentials?: Credentials;
    shared?: boolean;
    wsProtocols?: string[];
  }

  /** The events this panel listens for. noVNC dispatches plain CustomEvents. */
  interface RFBEventMap {
    connect: CustomEvent<undefined>;
    disconnect: CustomEvent<{ clean: boolean }>;
    credentialsrequired: CustomEvent<{ types: string[] }>;
    securityfailure: CustomEvent<{ status: number; reason: string }>;
  }

  export default class RFB extends EventTarget {
    constructor(target: Element, url: string, options?: Options);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    focusOnClick: boolean;
    clipViewport: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    sendCredentials(credentials: Credentials): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    addEventListener<K extends keyof RFBEventMap>(
      type: K,
      listener: (event: RFBEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ): void;
  }
}
