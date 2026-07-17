import { describe, it, expect } from "vitest";
import { formatBytes, formatSpeed, formatEta } from "./api";

describe("formatBytes", () => {
  it("formats each unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
  it("treats undefined as zero", () => {
    expect(formatBytes(undefined)).toBe("0 B");
  });
});

describe("formatSpeed", () => {
  it("appends /s", () => {
    expect(formatSpeed(1536)).toBe("1.5 KB/s");
    expect(formatSpeed(undefined)).toBe("0 B/s");
  });
});

describe("formatEta", () => {
  it("handles null/invalid", () => {
    expect(formatEta(null)).toBe("—");
    expect(formatEta(undefined)).toBe("—");
    expect(formatEta(-1)).toBe("—");
    expect(formatEta(Infinity)).toBe("—");
  });
  it("formats seconds / minutes / hours", () => {
    expect(formatEta(45)).toBe("45s");
    expect(formatEta(90)).toBe("1m30s");
    expect(formatEta(3700)).toBe("1h1m");
  });
});
