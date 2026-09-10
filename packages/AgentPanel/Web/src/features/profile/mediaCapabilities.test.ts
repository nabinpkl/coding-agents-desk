import { describe, expect, it } from "vitest";
import {
  canReceiveFragmentedVideo,
  detectMediaCapabilities,
  HEVC_FRAGMENT_TYPE,
  type MediaScope,
  summarizeMediaCapabilities,
} from "@/features/profile/mediaCapabilities";

function scope(overrides: Partial<MediaScope> = {}): MediaScope {
  return overrides;
}

describe("detectMediaCapabilities", () => {
  it("reports everything absent on a surface that has none of it", () => {
    const caps = detectMediaCapabilities(scope());
    expect(caps).toEqual({
      webTransport: false,
      managedMediaSource: false,
      mediaSource: false,
      videoDecoder: false,
      hevcFragmented: false,
    });
    expect(canReceiveFragmentedVideo(caps)).toBe(false);
  });

  it("asks ManagedMediaSource first, since that is the one iOS has", () => {
    const asked: string[] = [];
    const caps = detectMediaCapabilities(
      scope({
        ManagedMediaSource: {
          isTypeSupported: (type) => {
            asked.push(`managed:${type}`);
            return true;
          },
        },
        MediaSource: {
          isTypeSupported: (type) => {
            asked.push(`plain:${type}`);
            return false;
          },
        },
      }),
    );
    expect(asked).toEqual([`managed:${HEVC_FRAGMENT_TYPE}`]);
    expect(caps.hevcFragmented).toBe(true);
  });

  it("falls back to plain MediaSource when ManagedMediaSource is absent", () => {
    const caps = detectMediaCapabilities(
      scope({ MediaSource: { isTypeSupported: () => true } }),
    );
    expect(caps.managedMediaSource).toBe(false);
    expect(caps.mediaSource).toBe(true);
    expect(canReceiveFragmentedVideo(caps)).toBe(true);
  });

  it("treats a throwing isTypeSupported as a no rather than a crash", () => {
    const caps = detectMediaCapabilities(
      scope({
        MediaSource: {
          isTypeSupported: () => {
            throw new Error("unsupported on this engine");
          },
        },
      }),
    );
    expect(caps.hevcFragmented).toBe(false);
    expect(caps.mediaSource).toBe(true);
  });

  it("does not call an MSE that exists without isTypeSupported a capability", () => {
    const caps = detectMediaCapabilities(scope({ MediaSource: {} }));
    expect(caps.mediaSource).toBe(true);
    expect(caps.hevcFragmented).toBe(false);
    expect(canReceiveFragmentedVideo(caps)).toBe(false);
  });

  it("does not require WebTransport, which is the pipe and not the capability", () => {
    const caps = detectMediaCapabilities(
      scope({ ManagedMediaSource: { isTypeSupported: () => true } }),
    );
    expect(caps.webTransport).toBe(false);
    expect(canReceiveFragmentedVideo(caps)).toBe(true);
  });

  it("reports WebCodecs separately, since it is a path this design avoids", () => {
    const caps = detectMediaCapabilities(scope({ VideoDecoder: class {} }));
    expect(caps.videoDecoder).toBe(true);
    expect(canReceiveFragmentedVideo(caps)).toBe(false);
  });
});

describe("summarizeMediaCapabilities", () => {
  it("names every flag so a screenshot from a phone is readable on its own", () => {
    const line = summarizeMediaCapabilities({
      webTransport: true,
      managedMediaSource: true,
      mediaSource: false,
      videoDecoder: true,
      hevcFragmented: true,
    });
    expect(line).toBe("MMS yes · MSE no · hevc yes · WT yes · WC yes");
  });
});
